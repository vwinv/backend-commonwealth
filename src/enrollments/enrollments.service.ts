import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { EnrollmentStatus, Gender, ParentRelation, Prisma, SchoolYearStatus, UserRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { BillingService } from '../billing/billing.service';
import { MailService } from '../mail/mail.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';

const BCRYPT_ROUNDS = 10;

function parseParentRelation(raw: unknown): ParentRelation | null {
  const s = String(raw ?? '')
    .trim()
    .toUpperCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '');
  if (s === 'FATHER' || s === 'PERE') return ParentRelation.FATHER;
  if (s === 'MOTHER' || s === 'MERE') return ParentRelation.MOTHER;
  return null;
}

function generateTempPassword(length = 12): string {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(length);
  let s = '';
  for (let i = 0; i < length; i++) s += chars[bytes[i]! % chars.length]!;
  return s;
}

@Injectable()
export class EnrollmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly billing: BillingService,
    private readonly notifications: NotificationsService,
  ) {}

  private async requireOpenSchoolYear(label: string) {
    const row = await this.prisma.schoolYear.findUnique({ where: { label } });
    if (!row) {
      throw new BadRequestException("Année scolaire inconnue.");
    }
    if (row.status !== SchoolYearStatus.OPEN) {
      throw new BadRequestException("L'année scolaire sélectionnée n'est pas ouverte.");
    }
    return row;
  }

  private async getCurrentOpenSchoolYearLabel() {
    const row = await this.prisma.schoolYear.findFirst({
      where: { status: SchoolYearStatus.OPEN },
      orderBy: { startDate: 'desc' },
    });
    if (!row) {
      throw new BadRequestException("Aucune année scolaire n'est ouverte.");
    }
    return row.label;
  }

  /**
   * Compte parent dès la pré-inscription (mot de passe si nouveau ou compte sans mot de passe).
   * Retourne le mot de passe en clair uniquement quand il vient d’être défini (pour l’e-mail).
   */
  private async ensureParentAccountInTx(
    tx: Pick<PrismaService, 'user'>,
    email: string,
    fullName: string | null,
    phone: string | null,
    parentRelation: ParentRelation | null,
    parentAddress: string | null,
  ): Promise<{ parentId: string; plainPasswordForEmail: string | null }> {
    const existing = await tx.user.findUnique({ where: { email } });

    const relPatch = parentRelation != null ? { parentRelation } : {};
    const addrPatch =
      parentAddress != null && parentAddress.trim() !== '' ? { address: parentAddress.trim() } : {};

    if (existing?.passwordHash) {
      await tx.user.update({
        where: { id: existing.id },
        data: {
          fullName: fullName ?? undefined,
          phone: phone ?? undefined,
          ...relPatch,
          ...addrPatch,
        },
      });
      return { parentId: existing.id, plainPasswordForEmail: null };
    }

    const plainPassword = generateTempPassword();
    const passwordHash = await bcrypt.hash(plainPassword, BCRYPT_ROUNDS);

    if (existing) {
      await tx.user.update({
        where: { id: existing.id },
        data: {
          passwordHash,
          fullName: fullName ?? undefined,
          phone: phone ?? undefined,
          role: UserRole.PARENT,
          ...relPatch,
          ...addrPatch,
        },
      });
      return { parentId: existing.id, plainPasswordForEmail: plainPassword };
    }

    const created = await tx.user.create({
      data: {
        email,
        passwordHash,
        fullName,
        phone,
        role: UserRole.PARENT,
        ...(parentRelation != null ? { parentRelation } : {}),
        ...(parentAddress != null && parentAddress.trim() !== '' ? { address: parentAddress.trim() } : {}),
      },
    });
    return { parentId: created.id, plainPasswordForEmail: plainPassword };
  }

  async createPublicEnrollment(input: any) {
    const parentEmail = String(input?.parent?.email ?? '').trim().toLowerCase();
    if (!parentEmail) throw new BadRequestException('parent.email is required');

    const parentFirstName = String(input?.parent?.firstName ?? '').trim() || null;
    const parentLastName = String(input?.parent?.lastName ?? '').trim() || null;
    const parentFullName = String(input?.parent?.fullName ?? '').trim() || null;
    const parentPhone = String(input?.parent?.phone ?? '').trim() || null;
    const parentRelation = parseParentRelation(input?.parent?.relation);
    if (!parentRelation) {
      throw new BadRequestException('parent.relation is required (FATHER or MOTHER)');
    }
    const parentAddress = String(input?.parent?.address ?? '').trim();
    if (!parentAddress) {
      throw new BadRequestException('parent.address is required');
    }

    const childFirstName = String(input?.child?.firstName ?? '').trim();
    const childLastName = String(input?.child?.lastName ?? '').trim();
    if (!childFirstName || !childLastName) {
      throw new BadRequestException('child.firstName and child.lastName are required');
    }

    const levelId = String(input?.enrollment?.levelId ?? '').trim();
    let schoolYear = String(input?.enrollment?.schoolYear ?? '').trim();
    if (!levelId) {
      throw new BadRequestException('enrollment.levelId is required');
    }
    if (!schoolYear) schoolYear = await this.getCurrentOpenSchoolYearLabel();
    await this.requireOpenSchoolYear(schoolYear);

    const genderRaw = String(input?.child?.gender ?? '').trim().toUpperCase();
    const gender: Gender =
      genderRaw === 'FEMALE' || genderRaw === 'FILLE'
        ? Gender.FEMALE
        : genderRaw === 'MALE' || genderRaw === 'GARCON' || genderRaw === 'GARÇON'
          ? Gender.MALE
          : Gender.UNSPECIFIED;

    const birthDateRaw = String(input?.child?.birthDate ?? '').trim();
    const birthDate = birthDateRaw ? new Date(birthDateRaw) : null;
    if (birthDateRaw && Number.isNaN(birthDate?.getTime())) {
      throw new BadRequestException('child.birthDate must be a valid date');
    }

    const classId = input?.enrollment?.classId ? String(input.enrollment.classId).trim() : null;
    const validationNote = input?.enrollment?.note ? String(input.enrollment.note).trim() : null;

    const displayNameForMail = parentFullName || [parentFirstName, parentLastName].filter(Boolean).join(' ').trim() || null;

    const result = await this.prisma.$transaction(async (tx) => {
      const { parentId, plainPasswordForEmail } = await this.ensureParentAccountInTx(
        tx,
        parentEmail,
        displayNameForMail,
        parentPhone,
        parentRelation,
        parentAddress,
      );

      const child = await tx.child.create({
        data: {
          parentId,
          firstName: childFirstName,
          lastName: childLastName,
          birthDate: birthDate ?? undefined,
          gender,
        },
      });

      const enrollment = await tx.enrollment.create({
        data: {
          childId: child.id,
          levelId,
          classId,
          schoolYear,
          status: EnrollmentStatus.PENDING,
          validationNote,
          pendingParentEmail: parentEmail,
          pendingParentFirstName: parentFirstName,
          pendingParentLastName: parentLastName,
          pendingParentPhone: parentPhone,
          pendingParentRelation: parentRelation,
          pendingParentAddress: parentAddress,
        },
        include: {
          child: true,
          level: true,
          class: true,
        },
      });

      const services = Array.isArray(input?.options?.services)
        ? input.options.services.map((s: unknown) => String(s))
        : [];
      if (services.length) {
        await this.billing.attachServiceSubscriptionsFromCodes(tx, enrollment.id, services);
      }

      return { child, enrollment, plainPasswordForEmail };
    });

    await this.mail.sendPreEnrollmentConfirmation({
      to: parentEmail,
      parentName: displayNameForMail,
      parentPhone: parentPhone,
      schoolYear: result.enrollment.schoolYear,
      childLines: [
        `${result.child.lastName} ${result.child.firstName} — ${result.enrollment.level.name}`,
      ],
      plainPasswordForEmail: result.plainPasswordForEmail,
    });

    return { child: result.child, enrollment: result.enrollment };
  }

  async createPublicEnrollmentBatch(input: any) {
    const parentEmail = String(input?.parent?.email ?? '').trim().toLowerCase();
    if (!parentEmail) throw new BadRequestException('parent.email is required');

    const parentFirstName = String(input?.parent?.firstName ?? '').trim();
    const parentLastName = String(input?.parent?.lastName ?? '').trim();
    const parentFullNameFromParts =
      [parentFirstName, parentLastName].filter(Boolean).join(' ').trim() || null;
    const parentFullName = String(input?.parent?.fullName ?? '').trim() || parentFullNameFromParts;
    const parentPhone = String(input?.parent?.phone ?? '').trim() || null;
    const parentRelation = parseParentRelation(input?.parent?.relation);
    if (!parentRelation) {
      throw new BadRequestException('parent.relation is required (FATHER or MOTHER)');
    }
    const parentAddress = String(input?.parent?.address ?? '').trim();
    if (!parentAddress) {
      throw new BadRequestException('parent.address is required');
    }

    let schoolYear = String(input?.schoolYear ?? '').trim();
    if (!schoolYear) schoolYear = await this.getCurrentOpenSchoolYearLabel();
    await this.requireOpenSchoolYear(schoolYear);

    const rawChildren = input?.children;
    if (!Array.isArray(rawChildren) || rawChildren.length === 0) {
      throw new BadRequestException('children must be a non-empty array');
    }

    const services = Array.isArray(input?.options?.services) ? input.options.services.map(String) : [];
    const optionsComment = input?.options?.comment != null ? String(input.options.comment).trim() : '';
    const optionsLines: string[] = [];
    if (services.length) optionsLines.push(`Services souhaités: ${services.join(', ')}`);
    if (optionsComment) optionsLines.push(`Commentaire: ${optionsComment}`);
    const optionsNote = optionsLines.length ? optionsLines.join('\n') : null;

    const result = await this.prisma.$transaction(async (tx) => {
      const { parentId, plainPasswordForEmail } = await this.ensureParentAccountInTx(
        tx,
        parentEmail,
        parentFullName,
        parentPhone || null,
        parentRelation,
        parentAddress,
      );

      const created: Array<{ child: { id: string }; enrollment: { id: string; status: EnrollmentStatus } }> = [];

      for (const item of rawChildren) {
        const childFirstName = String(item?.firstName ?? '').trim();
        const childLastName = String(item?.lastName ?? '').trim();
        if (!childFirstName || !childLastName) {
          throw new BadRequestException('Each child must have firstName and lastName');
        }

        const levelId = String(item?.levelId ?? '').trim();
        if (!levelId) throw new BadRequestException('Each child must have levelId');

        const genderRaw = String(item?.gender ?? '').trim().toUpperCase();
        const gender: Gender =
          genderRaw === 'FEMALE' || genderRaw === 'FILLE'
            ? Gender.FEMALE
            : genderRaw === 'MALE' || genderRaw === 'GARCON' || genderRaw === 'GARÇON'
              ? Gender.MALE
              : Gender.UNSPECIFIED;

        const birthDateRaw = String(item?.birthDate ?? '').trim();
        const birthDate = birthDateRaw ? new Date(birthDateRaw) : null;
        if (birthDateRaw && Number.isNaN(birthDate?.getTime())) {
          throw new BadRequestException('child.birthDate must be a valid date');
        }

        const previousSchool = String(item?.previousSchool ?? '').trim();
        const perChildNoteParts = [
          optionsNote,
          previousSchool ? `Établissement actuel / précédent: ${previousSchool}` : null,
        ].filter(Boolean) as string[];
        const validationNote = perChildNoteParts.length ? perChildNoteParts.join('\n') : null;

        const child = await tx.child.create({
          data: {
            parentId,
            firstName: childFirstName,
            lastName: childLastName,
            birthDate: birthDate ?? undefined,
            gender,
          },
        });

        const enrollment = await tx.enrollment.create({
          data: {
            childId: child.id,
            levelId,
            schoolYear,
            status: EnrollmentStatus.PENDING,
            validationNote,
            pendingParentEmail: parentEmail,
            pendingParentFirstName: parentFirstName || null,
            pendingParentLastName: parentLastName || null,
            pendingParentPhone: parentPhone || null,
            pendingParentRelation: parentRelation,
            pendingParentAddress: parentAddress,
          },
          include: {
            child: true,
            level: true,
            class: true,
          },
        });

        if (services.length) {
          await this.billing.attachServiceSubscriptionsFromCodes(tx, enrollment.id, services);
        }

        created.push({ child: { id: child.id }, enrollment: { id: enrollment.id, status: enrollment.status } });
      }

      return { enrollments: created, plainPasswordForEmail };
    });

    const ids = result.enrollments.map((e) => e.enrollment.id);
    const rows = await this.prisma.enrollment.findMany({
      where: { id: { in: ids } },
      include: { child: true, level: true },
      orderBy: { createdAt: 'asc' },
    });

    await this.mail.sendPreEnrollmentConfirmation({
      to: parentEmail,
      parentName: parentFullName,
      parentPhone: parentPhone || null,
      schoolYear,
      childLines: rows.map((e) => `${e.child.lastName} ${e.child.firstName} — ${e.level.name}`),
      plainPasswordForEmail: result.plainPasswordForEmail,
    });

    return { enrollments: result.enrollments };
  }

  async list(params: { status?: string }) {
    const statusRaw = params.status?.trim().toUpperCase();
    const status = statusRaw && statusRaw in EnrollmentStatus ? (statusRaw as EnrollmentStatus) : undefined;

    return this.prisma.enrollment.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: 'desc' },
      include: {
        child: { include: { parent: true } },
        level: true,
        class: true,
        payments: true,
      },
    });
  }

  async getOne(id: string) {
    const enrollment = await this.prisma.enrollment.findUnique({
      where: { id },
      include: {
        child: { include: { parent: true } },
        level: true,
        class: true,
        payments: { orderBy: [{ year: 'desc' }, { month: 'desc' }] },
        tuitionCharges: true,
        monthlyInstallments: {
          orderBy: [{ year: 'desc' }, { month: 'desc' }],
          include: { lines: { include: { serviceTariff: true } } },
        },
        serviceSubscriptions: { include: { serviceTariff: true } },
      },
    });
    if (!enrollment) throw new NotFoundException('Enrollment not found');
    return enrollment;
  }

  /** Validation admin : pas de création de compte (déjà fait à l’inscription). */
  async approve(id: string, input: any) {
    const validatedById = String(input?.validatedById ?? '').trim();
    if (!validatedById) throw new BadRequestException('validatedById is required');

    const classId = input?.classId ? String(input.classId).trim() : undefined;
    const note = input?.note ? String(input.note).trim() : undefined;

    const enrollment = await this.prisma.enrollment.findUnique({
      where: { id },
      select: { status: true },
    });
    if (!enrollment) throw new NotFoundException('Enrollment not found');
    if (enrollment.status !== EnrollmentStatus.PENDING) {
      throw new BadRequestException('Seules les inscriptions en attente peuvent être approuvées');
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.enrollment.update({
          where: { id },
          data: {
            status: EnrollmentStatus.APPROVED,
            classId,
            validatedAt: new Date(),
            validatedById,
            validationNote: note,
          },
        });
        await this.billing.setupAfterApproval(tx, id);
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        throw new NotFoundException('Enrollment not found');
      }
      throw e;
    }

    await this.notifications.notifyEnrollmentApproved(id)
      .catch(() => undefined);

    return this.getOne(id);
  }

  async reject(id: string, input: any) {
    const validatedById = String(input?.validatedById ?? '').trim();
    if (!validatedById) throw new BadRequestException('validatedById is required');

    const note = input?.note ? String(input.note).trim() : undefined;

    try {
      const row = await this.prisma.enrollment.update({
        where: { id },
        data: {
          status: EnrollmentStatus.REJECTED,
          validatedAt: new Date(),
          validatedById,
          validationNote: note,
        },
      });
      await this.notifications.notifyEnrollmentRejected(id).catch(() => undefined);
      return row;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
        throw new NotFoundException('Enrollment not found');
      }
      throw e;
    }
  }
}
