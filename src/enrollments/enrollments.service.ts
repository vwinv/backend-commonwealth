import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnrollmentStatus, Gender, ParentRelation, Prisma, SchoolYearStatus, UserRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { BillingService } from '../billing/billing.service';
import { MailService } from '../mail/mail.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { parsePublicHealthInput, upsertChildHealthRecordInTx } from './enrollment-health.util';
import {
  buildWizardData,
  generateResumeToken,
  parseWizardData,
  parseWizardOptionsInput,
} from './enrollment-wizard.util';
import {
  assertLevelEnrollmentOpen,
  resolveClassIdForApproval,
} from './class-capacity.util';
import { saveEnrollmentParentSignatureFromDataUrl } from './enrollment-signature.util';

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

function parseGender(raw: unknown): Gender {
  const genderRaw = String(raw ?? '').trim().toUpperCase();
  if (genderRaw === 'FEMALE' || genderRaw === 'FILLE') return Gender.FEMALE;
  if (genderRaw === 'MALE' || genderRaw === 'GARCON' || genderRaw === 'GARÇON') return Gender.MALE;
  return Gender.UNSPECIFIED;
}

function parseBirthDate(raw: unknown): Date | null {
  const birthDateRaw = String(raw ?? '').trim();
  if (!birthDateRaw) return null;
  const birthDate = new Date(birthDateRaw);
  if (Number.isNaN(birthDate.getTime())) {
    throw new BadRequestException('birthDate must be a valid date');
  }
  return birthDate;
}

function genderToFrontend(gender: Gender): string {
  if (gender === Gender.FEMALE) return 'Fille';
  if (gender === Gender.MALE) return 'Garçon';
  return 'Fille';
}

function vaccinationIdFromName(name: string): string {
  const n = name.trim().toLowerCase();
  if (n === 'bcg') return 'bcg';
  if (n.startsWith('dtp')) return 'dtp1';
  if (n === 'ror') return 'ror';
  return n.replace(/\s+/g, '-');
}

@Injectable()
export class EnrollmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly billing: BillingService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
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
    options?: { issueNewPassword?: boolean },
  ): Promise<{ parentId: string; plainPasswordForEmail: string | null }> {
    const issueNewPassword = options?.issueNewPassword !== false;
    const existing = await tx.user.findUnique({ where: { email } });

    const relPatch = parentRelation != null ? { parentRelation } : {};
    const addrPatch =
      parentAddress != null && parentAddress.trim() !== '' ? { address: parentAddress.trim() } : {};

    if (existing && !issueNewPassword) {
      await tx.user.update({
        where: { id: existing.id },
        data: {
          fullName: fullName ?? undefined,
          phone: phone ?? undefined,
          role: UserRole.PARENT,
          ...relPatch,
          ...addrPatch,
        },
      });
      return { parentId: existing.id, plainPasswordForEmail: null };
    }

    // Compte actif (mot de passe déjà personnalisé) : pas de nouveau mot de passe.
    if (existing?.passwordHash && !existing.mustChangePassword) {
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
          mustChangePassword: true,
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
        mustChangePassword: true,
        ...(parentRelation != null ? { parentRelation } : {}),
        ...(parentAddress != null && parentAddress.trim() !== '' ? { address: parentAddress.trim() } : {}),
      },
    });
    return { parentId: created.id, plainPasswordForEmail: plainPassword };
  }

  /**
   * Si le parent est encore sur un mot de passe provisoire (mustChangePassword) mais qu'on n'a
   * pas le clair (ex. compte créé à l'étape famille), en génère un nouveau pour l'e-mail final.
   */
  private async issueProvisionalPasswordForEmailIfNeeded(
    tx: Pick<PrismaService, 'user'>,
    parentId: string,
    plainPasswordFromEnsure: string | null,
  ): Promise<string | null> {
    if (plainPasswordFromEnsure) return plainPasswordFromEnsure;

    const user = await tx.user.findUnique({
      where: { id: parentId },
      select: { mustChangePassword: true, passwordHash: true },
    });
    if (!user?.mustChangePassword) return null;

    const plainPassword = generateTempPassword();
    const passwordHash = await bcrypt.hash(plainPassword, BCRYPT_ROUNDS);
    await tx.user.update({
      where: { id: parentId },
      data: { passwordHash, mustChangePassword: true },
    });
    return plainPassword;
  }

  /** Compte parent déjà actif : pas de nouveau mot de passe ni d'identifiants dans les e-mails. */
  private async shouldSkipParentCredentialsEmail(
    email: string,
    explicitFlag?: boolean,
  ): Promise<boolean> {
    if (explicitFlag === true) return true;

    const user = await this.prisma.user.findUnique({
      where: { email: email.trim().toLowerCase() },
      select: { role: true, passwordHash: true },
    });

    return Boolean(user?.role === UserRole.PARENT && user.passwordHash);
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
      await assertLevelEnrollmentOpen(tx, levelId, schoolYear);

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

  /**
   * Étape famille du wizard : compte parent, pré-inscription PENDING, e-mail de reprise.
   */
  async savePublicEnrollmentFamily(input: any) {
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

    const childFirstName = String(input?.child?.firstName ?? '').trim();
    const childLastName = String(input?.child?.lastName ?? '').trim();
    if (!childFirstName || !childLastName) {
      throw new BadRequestException('child.firstName and child.lastName are required');
    }

    const levelId = String(input?.child?.levelId ?? '').trim();
    if (!levelId) throw new BadRequestException('child.levelId is required');

    let schoolYear = String(input?.schoolYear ?? '').trim();
    if (!schoolYear) schoolYear = await this.getCurrentOpenSchoolYearLabel();
    await this.requireOpenSchoolYear(schoolYear);

    const gender = parseGender(input?.child?.gender);
    const birthDate = parseBirthDate(input?.child?.birthDate);
    const wizardData = buildWizardData({
      child: input?.child,
      parent: input?.parent,
      guardian2: input?.guardian2,
      emergency: input?.emergency,
    });

    const childIdIn = String(input?.childId ?? '').trim() || null;
    const enrollmentIdIn = String(input?.enrollmentId ?? '').trim() || null;

    const level = await this.prisma.level.findUnique({ where: { id: levelId }, select: { name: true } });
    if (!level) throw new BadRequestException('Niveau inconnu.');

    let skipParentCredentials = await this.shouldSkipParentCredentialsEmail(
      parentEmail,
      input?.existingParentAccount === true,
    );

    if (childIdIn && enrollmentIdIn) {
      const prior = await this.prisma.enrollment.findFirst({
        where: { id: enrollmentIdIn, childId: childIdIn, status: EnrollmentStatus.PENDING },
        include: { child: { include: { parent: { select: { id: true, email: true } } } } },
      });
      if (prior?.child?.parentId && prior.child.parent?.email?.toLowerCase() === parentEmail) {
        skipParentCredentials = true;
      }
    }

    const txResult = await this.prisma.$transaction(async (tx) => {
      const excludeEnrollmentId = enrollmentIdIn ?? undefined;
      await assertLevelEnrollmentOpen(tx, levelId, schoolYear, excludeEnrollmentId);

      const { parentId, plainPasswordForEmail } = await this.ensureParentAccountInTx(
        tx,
        parentEmail,
        parentFullName,
        parentPhone,
        parentRelation,
        parentAddress,
        { issueNewPassword: !skipParentCredentials },
      );

      const childData = {
        firstName: childFirstName,
        lastName: childLastName,
        birthDate: birthDate ?? undefined,
        gender,
      };

      const pendingParentData = {
        pendingParentEmail: parentEmail,
        pendingParentFirstName: parentFirstName || null,
        pendingParentLastName: parentLastName || null,
        pendingParentPhone: parentPhone,
        pendingParentRelation: parentRelation,
        pendingParentAddress: parentAddress,
      };

      let child: { id: string };
      let enrollment: { id: string; resumeToken: string | null };

      if (childIdIn && enrollmentIdIn) {
        const row = await tx.enrollment.findFirst({
          where: {
            id: enrollmentIdIn,
            status: EnrollmentStatus.PENDING,
            childId: childIdIn,
          },
        });
        if (!row) {
          throw new BadRequestException('Inscription introuvable ou déjà traitée.');
        }
        child = await tx.child.update({
          where: { id: row.childId },
          data: { ...childData, parentId },
        });
        const resumeToken = row.resumeToken ?? generateResumeToken();
        enrollment = await tx.enrollment.update({
          where: { id: row.id },
          data: {
            levelId,
            wizardStep: 3,
            wizardData: wizardData as Prisma.InputJsonValue,
            resumeToken,
            ...pendingParentData,
          },
        });
      } else {
        const existing = await tx.enrollment.findFirst({
          where: {
            status: EnrollmentStatus.PENDING,
            schoolYear,
            wizardStep: { lt: 5 },
            child: { parentId, firstName: childFirstName, lastName: childLastName },
          },
          orderBy: { createdAt: 'desc' },
        });

        if (existing) {
          child = await tx.child.update({ where: { id: existing.childId }, data: childData });
          const resumeToken = existing.resumeToken ?? generateResumeToken();
          enrollment = await tx.enrollment.update({
            where: { id: existing.id },
            data: {
              levelId,
              wizardStep: 3,
              wizardData: wizardData as Prisma.InputJsonValue,
              resumeToken,
              ...pendingParentData,
            },
          });
        } else {
          child = await tx.child.create({ data: { parentId, ...childData } });
          const resumeToken = generateResumeToken();
          enrollment = await tx.enrollment.create({
            data: {
              childId: child.id,
              levelId,
              schoolYear,
              status: EnrollmentStatus.PENDING,
              wizardStep: 3,
              wizardData: wizardData as Prisma.InputJsonValue,
              resumeToken,
              ...pendingParentData,
            },
          });
        }
      }

      return {
        childId: child.id,
        enrollmentId: enrollment.id,
        resumeToken: enrollment.resumeToken!,
        plainPasswordForEmail,
        sendProgressEmail: !skipParentCredentials,
      };
    });

    if (txResult.sendProgressEmail) {
      await this.mail.sendEnrollmentProgressSaved({
        to: parentEmail,
        parentName: parentFullName,
        parentPhone,
        schoolYear,
        childLine: `${childLastName} ${childFirstName} — ${level.name}`,
        resumeUrl: this.inscriptionResumeUrl(txResult.resumeToken),
        plainPasswordForEmail: txResult.plainPasswordForEmail,
      });
    }

    return {
      childId: txResult.childId,
      enrollmentId: txResult.enrollmentId,
      resumeToken: txResult.resumeToken,
    };
  }

  async getPublicEnrollmentResume(token: string) {
    const resumeToken = String(token ?? '').trim();
    if (!resumeToken) throw new BadRequestException('token is required');

    const enrollment = await this.prisma.enrollment.findFirst({
      where: {
        resumeToken,
        status: EnrollmentStatus.PENDING,
        wizardStep: { lt: 5 },
      },
      include: {
        child: {
          include: {
            healthRecord: { include: { vaccinations: { orderBy: { createdAt: 'asc' } } } },
          },
        },
        level: true,
      },
    });
    if (!enrollment) {
      throw new NotFoundException('Dossier introuvable ou déjà finalisé.');
    }

    const wizard = parseWizardData(enrollment.wizardData);
    const extras = wizard.childExtras ?? {};
    const parentExtras = wizard.parentExtras ?? {};

    const healthRecord = enrollment.child.healthRecord;
    const vaccinations = healthRecord?.vaccinations?.length
      ? healthRecord.vaccinations.map((v) => ({
          id: vaccinationIdFromName(v.name),
          label: v.name,
          administeredAt: v.vaccinatedAt
            ? v.vaccinatedAt.toISOString().slice(0, 10)
            : '',
        }))
      : undefined;

    return {
      step: Math.min(Math.max(enrollment.wizardStep, 1), 5) as number,
      schoolYear: enrollment.schoolYear,
      childId: enrollment.childId,
      enrollmentId: enrollment.id,
      resumeToken: enrollment.resumeToken,
      child: {
        firstName: enrollment.child.firstName,
        lastName: enrollment.child.lastName,
        birthDate: enrollment.child.birthDate
          ? enrollment.child.birthDate.toISOString().slice(0, 10)
          : '',
        birthPlace: extras.birthPlace ?? '',
        nationality: extras.nationality ?? '',
        gender: genderToFrontend(enrollment.child.gender),
        homeLanguages: extras.homeLanguages ?? '',
        matricule: extras.matricule ?? '',
        levelId: enrollment.levelId,
        levelName: extras.levelName ?? enrollment.level.name,
        childAddress: extras.childAddress ?? '',
        previousSchool: extras.previousSchool ?? '',
      },
      parent: {
        fullName:
          [enrollment.pendingParentFirstName, enrollment.pendingParentLastName]
            .filter(Boolean)
            .join(' ')
            .trim() || '',
        firstName: enrollment.pendingParentFirstName ?? '',
        lastName: enrollment.pendingParentLastName ?? '',
        relation: enrollment.pendingParentRelation ?? '',
        phone: enrollment.pendingParentPhone ?? '',
        email: enrollment.pendingParentEmail ?? '',
        profession: parentExtras.profession ?? '',
        address: enrollment.pendingParentAddress ?? '',
      },
      guardian2: wizard.guardian2 ?? {
        fullName: '',
        relation: '',
        phone: '',
        email: '',
      },
      emergency: wizard.emergency ?? {
        source: '',
        fullName: '',
        relation: '',
        phone: '',
      },
      health: healthRecord
        ? {
            doctorName: healthRecord.doctorName ?? '',
            doctorPhone: healthRecord.doctorPhone ?? '',
            bloodGroup: healthRecord.bloodGroup ?? '',
            knownAllergies: healthRecord.knownAllergies ?? '',
            ongoingTreatments: healthRecord.ongoingTreatments ?? '',
            dietaryRegime: healthRecord.dietaryRegime ?? '',
            instructions: healthRecord.instructions ?? '',
            vaccinations,
          }
        : undefined,
      options: wizard.options
        ? {
            scheduleId: wizard.options.scheduleId ?? '',
            scheduleLabel: wizard.options.scheduleLabel ?? '',
            authorizations: {
              photosInternal: wizard.options.authorizations?.photosInternal ?? false,
              photosCommunication: wizard.options.authorizations?.photosCommunication ?? false,
              outings: wizard.options.authorizations?.outings ?? false,
              firstAid: wizard.options.authorizations?.firstAid ?? false,
            },
            serviceSelections: wizard.options.serviceSelections ?? [],
            comment: wizard.options.comment ?? '',
          }
        : {
            scheduleId: '',
            scheduleLabel: '',
            authorizations: {
              photosInternal: false,
              photosCommunication: false,
              outings: false,
              firstAid: false,
            },
            serviceSelections: [],
            comment: '',
          },
      scheduleId: enrollment.scheduleId ?? '',
    };
  }

  private inscriptionResumeUrl(resumeToken: string): string {
    const explicit = this.config.get<string>('PUBLIC_INSCRIPTION_URL')?.trim();
    if (explicit) {
      return `${explicit.replace(/\/$/, '')}?resume=${encodeURIComponent(resumeToken)}`;
    }
    const login =
      this.config.get<string>('PARENT_PORTAL_LOGIN_URL')?.trim() ||
      'http://localhost:3000/parent/login';
    const site = login.replace(/\/parent\/login\/?$/i, '') || 'http://localhost:3000';
    return `${site.replace(/\/$/, '')}/inscription?resume=${encodeURIComponent(resumeToken)}`;
  }

  /**
   * Étape santé du wizard : crée ou met à jour une pré-inscription PENDING + fiche médicale.
   * Pas d’e-mail de confirmation (réservé à la validation finale).
   */
  async savePublicEnrollmentHealth(input: any) {
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

    const childFirstName = String(input?.child?.firstName ?? '').trim();
    const childLastName = String(input?.child?.lastName ?? '').trim();
    if (!childFirstName || !childLastName) {
      throw new BadRequestException('child.firstName and child.lastName are required');
    }

    const levelId = String(input?.child?.levelId ?? '').trim();
    if (!levelId) throw new BadRequestException('child.levelId is required');

    let schoolYear = String(input?.schoolYear ?? '').trim();
    if (!schoolYear) schoolYear = await this.getCurrentOpenSchoolYearLabel();
    await this.requireOpenSchoolYear(schoolYear);

    const gender = parseGender(input?.child?.gender);
    const birthDate = parseBirthDate(input?.child?.birthDate);

    const health = parsePublicHealthInput(input?.health);
    if (!health.doctorName) throw new BadRequestException('health.doctorName is required');
    if (!health.doctorPhone) throw new BadRequestException('health.doctorPhone is required');
    if (!health.bloodGroup) throw new BadRequestException('health.bloodGroup is required');

    const childIdIn = String(input?.childId ?? '').trim() || null;
    const enrollmentIdIn = String(input?.enrollmentId ?? '').trim() || null;

    return this.prisma.$transaction(async (tx) => {
      const excludeEnrollmentId = enrollmentIdIn ?? undefined;
      await assertLevelEnrollmentOpen(tx, levelId, schoolYear, excludeEnrollmentId);

      const { parentId } = await this.ensureParentAccountInTx(
        tx,
        parentEmail,
        parentFullName,
        parentPhone,
        parentRelation,
        parentAddress,
      );

      let child: { id: string };
      let enrollment: { id: string };

      const childData = {
        firstName: childFirstName,
        lastName: childLastName,
        birthDate: birthDate ?? undefined,
        gender,
      };

      const pendingParentData = {
        pendingParentEmail: parentEmail,
        pendingParentFirstName: parentFirstName || null,
        pendingParentLastName: parentLastName || null,
        pendingParentPhone: parentPhone,
        pendingParentRelation: parentRelation,
        pendingParentAddress: parentAddress,
      };

      if (childIdIn && enrollmentIdIn) {
        const row = await tx.enrollment.findFirst({
          where: {
            id: enrollmentIdIn,
            status: EnrollmentStatus.PENDING,
            childId: childIdIn,
          },
          include: { child: true },
        });
        if (!row) {
          throw new BadRequestException('Inscription introuvable ou déjà traitée.');
        }
        child = await tx.child.update({
          where: { id: row.childId },
          data: { ...childData, parentId },
        });
        enrollment = await tx.enrollment.update({
          where: { id: row.id },
          data: { levelId, ...pendingParentData },
        });
      } else {
        const existing = await tx.enrollment.findFirst({
          where: {
            status: EnrollmentStatus.PENDING,
            schoolYear,
            child: { parentId, firstName: childFirstName, lastName: childLastName },
          },
          include: { child: true },
          orderBy: { createdAt: 'desc' },
        });

        if (existing) {
          child = await tx.child.update({ where: { id: existing.childId }, data: childData });
          enrollment = await tx.enrollment.update({
            where: { id: existing.id },
            data: { levelId, ...pendingParentData },
          });
        } else {
          child = await tx.child.create({ data: { parentId, ...childData } });
          enrollment = await tx.enrollment.create({
            data: {
              childId: child.id,
              levelId,
              schoolYear,
              status: EnrollmentStatus.PENDING,
              ...pendingParentData,
            },
          });
        }
      }

      await upsertChildHealthRecordInTx(tx, child.id, health);

      await tx.enrollment.update({
        where: { id: enrollment.id },
        data: { wizardStep: 4 },
      });

      return { childId: child.id, enrollmentId: enrollment.id };
    });
  }

  /**
   * Étape horaires & options du wizard : formule horaire, services et autorisations.
   */
  async savePublicEnrollmentOptions(input: any) {
    const parentEmail = String(input?.parent?.email ?? '').trim().toLowerCase();
    if (!parentEmail) throw new BadRequestException('parent.email is required');

    const childIdIn = String(input?.childId ?? '').trim() || null;
    const enrollmentIdIn = String(input?.enrollmentId ?? '').trim() || null;
    if (!childIdIn || !enrollmentIdIn) {
      throw new BadRequestException('childId and enrollmentId are required');
    }

    const levelId = String(input?.child?.levelId ?? '').trim();
    if (!levelId) throw new BadRequestException('child.levelId is required');

    let schoolYear = String(input?.schoolYear ?? '').trim();
    if (!schoolYear) schoolYear = await this.getCurrentOpenSchoolYearLabel();
    await this.requireOpenSchoolYear(schoolYear);

    const parsedOptions = parseWizardOptionsInput(input?.options ?? {});
    const scheduleId = String(parsedOptions.scheduleId ?? '').trim() || null;

    if (scheduleId) {
      const schedule = await this.prisma.levelSchedule.findFirst({
        where: { id: scheduleId, levelId, schoolYear, active: true },
        select: { id: true, label: true },
      });
      if (!schedule) {
        throw new BadRequestException('Formule horaire invalide pour ce niveau.');
      }
      parsedOptions.scheduleLabel = schedule.label;
    } else {
      const scheduleCount = await this.prisma.levelSchedule.count({
        where: { levelId, schoolYear, active: true },
      });
      if (scheduleCount > 0) {
        throw new BadRequestException('Sélectionnez une formule horaire.');
      }
    }

    const serviceSelections = Array.isArray(parsedOptions.serviceSelections)
      ? parsedOptions.serviceSelections
      : [];

    return this.prisma.$transaction(async (tx) => {
      const row = await tx.enrollment.findFirst({
        where: {
          id: enrollmentIdIn,
          status: EnrollmentStatus.PENDING,
          childId: childIdIn,
          pendingParentEmail: parentEmail,
        },
      });
      if (!row) {
        throw new BadRequestException('Inscription introuvable ou déjà traitée.');
      }

      const wizardData = buildWizardData({
        child: input?.child,
        parent: input?.parent,
        guardian2: input?.guardian2,
        emergency: input?.emergency,
        options: {
          ...parsedOptions,
          serviceSelections,
        },
      });

      const enrollment = await tx.enrollment.update({
        where: { id: row.id },
        data: {
          scheduleId,
          wizardStep: 5,
          wizardData: wizardData as Prisma.InputJsonValue,
        },
      });

      await this.billing.replaceServiceSubscriptions(tx, enrollment.id, serviceSelections);

      return { childId: childIdIn, enrollmentId: enrollment.id };
    });
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
    const parsedOptions = parseWizardOptionsInput(input?.options ?? {});
    const serviceSelections = parsedOptions.serviceSelections ?? [];
    const scheduleId = String(parsedOptions.scheduleId ?? '').trim() || null;
    const optionsComment = parsedOptions.comment ?? (input?.options?.comment != null ? String(input.options.comment).trim() : '');
    const optionsLines: string[] = [];
    if (parsedOptions.scheduleLabel) {
      optionsLines.push(`Formule horaire: ${parsedOptions.scheduleLabel}`);
    }
    if (serviceSelections.length) {
      optionsLines.push(
        `Services: ${serviceSelections.map((s) => s.code).join(', ')}`,
      );
    } else if (services.length) {
      optionsLines.push(`Services souhaités: ${services.join(', ')}`);
    }
    if (parsedOptions.authorizations) {
      const authLabels: string[] = [];
      if (parsedOptions.authorizations.photosInternal) authLabels.push('photos internes');
      if (parsedOptions.authorizations.photosCommunication) authLabels.push('photos communication');
      if (parsedOptions.authorizations.outings) authLabels.push('sorties');
      if (parsedOptions.authorizations.firstAid) authLabels.push('premiers secours');
      if (authLabels.length) optionsLines.push(`Autorisations: ${authLabels.join(', ')}`);
    }
    if (optionsComment) optionsLines.push(`Commentaire: ${optionsComment}`);
    const optionsNote = optionsLines.length ? optionsLines.join('\n') : null;

    const engagementRaw = input?.engagement ?? {};
    const engagementCertified = engagementRaw?.certified === true;
    const engagementSignedPlace = String(engagementRaw?.signedPlace ?? '').trim();
    const engagementSignedAt = String(engagementRaw?.signedAt ?? '').trim();
    const engagementSignatureMode = String(engagementRaw?.signatureMode ?? '').trim();
    const engagementSignatureDataUrl = String(engagementRaw?.signatureDataUrl ?? '').trim();
    if (!engagementCertified) {
      throw new BadRequestException('engagement.certified is required');
    }
    if (!engagementSignedPlace) {
      throw new BadRequestException('engagement.signedPlace is required');
    }
    if (!engagementSignedAt) {
      throw new BadRequestException('engagement.signedAt is required');
    }
    if (!engagementSignatureDataUrl) {
      throw new BadRequestException('engagement.signatureDataUrl is required');
    }

    const skipParentCredentials = await this.shouldSkipParentCredentialsEmail(
      parentEmail,
      input?.existingParentAccount === true,
    );

    const result = await this.prisma.$transaction(async (tx) => {
      const { parentId, plainPasswordForEmail: plainFromEnsure } = await this.ensureParentAccountInTx(
        tx,
        parentEmail,
        parentFullName,
        parentPhone || null,
        parentRelation,
        parentAddress,
        { issueNewPassword: false },
      );
      const plainPasswordForEmail = skipParentCredentials
        ? null
        : await this.issueProvisionalPasswordForEmailIfNeeded(tx, parentId, plainFromEnsure);

      const created: Array<{ child: { id: string }; enrollment: { id: string; status: EnrollmentStatus } }> = [];

      for (const item of rawChildren) {
        const enrollmentIdIn = String(item?.enrollmentId ?? '').trim() || null;

        if (enrollmentIdIn) {
          const existing = await tx.enrollment.findFirst({
            where: {
              id: enrollmentIdIn,
              status: EnrollmentStatus.PENDING,
              child: { parentId },
            },
            include: { child: true },
          });
          if (!existing) {
            throw new BadRequestException('Inscription introuvable ou déjà traitée.');
          }

          const childFirstName = String(item?.firstName ?? existing.child.firstName).trim();
          const childLastName = String(item?.lastName ?? existing.child.lastName).trim();
          const levelId = String(item?.levelId ?? existing.levelId).trim();
          if (!levelId) throw new BadRequestException('Each child must have levelId');

          await assertLevelEnrollmentOpen(tx, levelId, schoolYear, existing.id);

          const gender = parseGender(item?.gender ?? existing.child.gender);
          const birthDate = item?.birthDate != null ? parseBirthDate(item.birthDate) : existing.child.birthDate;

          const previousSchool = String(item?.previousSchool ?? '').trim();
          const perChildNoteParts = [
            optionsNote,
            previousSchool ? `Établissement actuel / précédent: ${previousSchool}` : null,
          ].filter(Boolean) as string[];
          const validationNote = perChildNoteParts.length ? perChildNoteParts.join('\n') : null;

          await tx.child.update({
            where: { id: existing.childId },
            data: {
              firstName: childFirstName,
              lastName: childLastName,
              birthDate: birthDate ?? undefined,
              gender,
            },
          });

          const wizardData = buildWizardData({
            child: item,
            parent: input?.parent,
            guardian2: item?.guardian2,
            emergency: item?.emergency,
            options: input?.options,
            engagement: {
              certified: true,
              signedPlace: engagementSignedPlace,
              signedAt: engagementSignedAt,
              signatureMode: engagementSignatureMode,
              parentSignatureUrl: saveEnrollmentParentSignatureFromDataUrl(
                existing.id,
                engagementSignatureDataUrl,
              ),
            },
          });

          const enrollment = await tx.enrollment.update({
            where: { id: existing.id },
            data: {
              levelId,
              scheduleId,
              validationNote,
              wizardStep: 5,
              wizardData: wizardData as Prisma.InputJsonValue,
              pendingParentEmail: parentEmail,
              pendingParentFirstName: parentFirstName || null,
              pendingParentLastName: parentLastName || null,
              pendingParentPhone: parentPhone || null,
              pendingParentRelation: parentRelation,
              pendingParentAddress: parentAddress,
            },
          });

          if (item?.health) {
            await upsertChildHealthRecordInTx(tx, existing.childId, parsePublicHealthInput(item.health));
          }

          if (serviceSelections.length) {
            await this.billing.replaceServiceSubscriptions(tx, enrollment.id, serviceSelections);
          } else if (services.length) {
            await this.billing.attachServiceSubscriptionsFromCodes(tx, enrollment.id, services);
          }

          created.push({
            child: { id: existing.childId },
            enrollment: { id: enrollment.id, status: enrollment.status },
          });
          continue;
        }

        const childFirstName = String(item?.firstName ?? '').trim();
        const childLastName = String(item?.lastName ?? '').trim();
        if (!childFirstName || !childLastName) {
          throw new BadRequestException('Each child must have firstName and lastName');
        }

        const levelId = String(item?.levelId ?? '').trim();
        if (!levelId) throw new BadRequestException('Each child must have levelId');

        await assertLevelEnrollmentOpen(tx, levelId, schoolYear);

        const gender = parseGender(item?.gender);
        const birthDate = parseBirthDate(item?.birthDate);

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
            scheduleId,
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

        if (item?.health) {
          await upsertChildHealthRecordInTx(tx, child.id, parsePublicHealthInput(item.health));
        }

        if (serviceSelections.length) {
          await this.billing.replaceServiceSubscriptions(tx, enrollment.id, serviceSelections);
        } else if (services.length) {
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

    const classIdInput = input?.classId ? String(input.classId).trim() : undefined;
    const note = input?.note ? String(input.note).trim() : undefined;

    const enrollment = await this.prisma.enrollment.findUnique({
      where: { id },
      select: { status: true, levelId: true, schoolYear: true },
    });
    if (!enrollment) throw new NotFoundException('Enrollment not found');
    if (enrollment.status !== EnrollmentStatus.PENDING) {
      throw new BadRequestException('Seules les inscriptions en attente peuvent être approuvées');
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        const resolvedClassId = await resolveClassIdForApproval(
          tx,
          enrollment.levelId,
          enrollment.schoolYear,
          classIdInput,
        );

        await tx.enrollment.update({
          where: { id },
          data: {
            status: EnrollmentStatus.APPROVED,
            classId: resolvedClassId,
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

    const approved = await this.prisma.enrollment.findUnique({
      where: { id },
      include: {
        child: { include: { parent: true } },
        level: true,
      },
    });
    const parent = approved?.child?.parent;
    const parentEmail = parent?.email?.trim().toLowerCase() ?? '';
    if (approved && parent && parentEmail) {
      const childLine =
        `${approved.child.lastName} ${approved.child.firstName} — ${approved.level.name}`.trim();
      await this.mail.sendEnrollmentApprovedConfirmation({
        to: parentEmail,
        parentName: parent.fullName,
        parentPhone: parent.phone,
        schoolYear: approved.schoolYear,
        childLine,
      }).catch(() => undefined);
    }

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
