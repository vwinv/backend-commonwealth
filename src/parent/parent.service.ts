import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  EnrollmentStatus,
  FollowUpNoteCategory,
  FollowUpNoteStatus,
  Gender,
  DocumentSignatureStatus,
  ParentRelation,
  Prisma,
  SchoolSignatureType,
  SchoolYearStatus,
  UserRole,
  VaccinationStatus,
  WorkshopAccountKind,
  WorkshopReservationStatus,
} from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { BillingService } from '../billing/billing.service';
import { saveDocumentParentSignatureFromDataUrl } from '../admin/document-signature.util';
import { publishedDocumentsForParentWhere } from '../documents/document-audience.util';
import { MailService } from '../mail/mail.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { saveHealthRecordParentSignatureFromDataUrl } from './parent-health-signature.util';

function matriculeFromChildId(childId: string): string {
  const compact = childId.replace(/-/g, '').toUpperCase();
  return `MD${compact.slice(0, 6)}`;
}

function genderLabelFr(gender: Gender): string {
  if (gender === Gender.FEMALE) return 'Fille';
  if (gender === Gender.MALE) return 'Garçon';
  return '—';
}

function parentRelationLabelFr(rel: ParentRelation | null | undefined): 'Père' | 'Mère' | null {
  if (rel === ParentRelation.FATHER) return 'Père';
  if (rel === ParentRelation.MOTHER) return 'Mère';
  return null;
}

function splitAllergies(raw: string | null | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(/[,;|/]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function ageLabelShort(birthDate: Date | null): string {
  if (!birthDate) return '—';
  const now = new Date();
  let months =
    (now.getFullYear() - birthDate.getFullYear()) * 12 + (now.getMonth() - birthDate.getMonth());
  if (now.getDate() < birthDate.getDate()) months -= 1;
  if (months < 0) return '—';
  if (months < 12) {
    if (months === 0) return 'Né(e) récemment';
    return months === 1 ? '1 mois' : `${months} mois`;
  }
  const years = Math.floor(months / 12);
  return years === 1 ? '1 an' : `${years} ans`;
}

type ChildRow = {
  id: string;
  parentId: string | null;
  firstName: string;
  lastName: string;
  birthDate: Date | null;
  gender: Gender;
  allergies: string | null;
  createdAt: Date;
  updatedAt: Date;
};

@Injectable()
export class ParentService {
  private readonly logger = new Logger(ParentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly billing: BillingService,
    private readonly notifications: NotificationsService,
    private readonly mail: MailService,
  ) {}

  private async getOpenSchoolYearLabel() {
    const open = await this.prisma.schoolYear.findFirst({
      where: { status: SchoolYearStatus.OPEN },
      orderBy: { startDate: 'desc' },
    });
    if (!open) {
      throw new BadRequestException("Aucune année scolaire ouverte.");
    }
    return open.label;
  }

  /** Objet JSON sérialisable (évite soucis de sérialisation Nest / Prisma). */
  private toChildResponse(row: ChildRow, childNumber: number | null) {
    return {
      id: row.id,
      parentId: row.parentId,
      firstName: row.firstName,
      lastName: row.lastName,
      birthDate: row.birthDate ? row.birthDate.toISOString() : null,
      gender: row.gender,
      allergies: row.allergies,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      childNumber,
    };
  }

  async getMe(userId: string) {
    let user:
      | {
          id: string;
          email: string;
          fullName: string | null;
          profilePhotoUrl: string | null;
          phone: string | null;
          role: UserRole;
        }
      | null = null;
    try {
      user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          fullName: true,
          profilePhotoUrl: true,
          phone: true,
          address: true,
          parentRelation: true,
          role: true,
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2022') {
        const legacy = await this.prisma.user.findUnique({
          where: { id: userId },
          select: {
            id: true,
            email: true,
            fullName: true,
            phone: true,
            address: true,
            parentRelation: true,
            role: true,
          },
        });
        user = legacy ? { ...legacy, profilePhotoUrl: null } : null;
      } else {
        throw e;
      }
    }
    if (!user || user.role !== UserRole.PARENT) {
      throw new NotFoundException();
    }
    return user;
  }

  async updateMe(userId: string, body: Record<string, unknown>) {
    const fullName = String(body?.fullName ?? '').trim();
    const phoneRaw = body?.phone;
    const phone = phoneRaw === null || phoneRaw === undefined ? null : String(phoneRaw).trim();
    const addressRaw = body?.address;
    const address = addressRaw === null || addressRaw === undefined ? null : String(addressRaw).trim();
    if (!fullName) throw new BadRequestException('Le nom complet est obligatoire.');

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true },
    });
    if (!user || user.role !== UserRole.PARENT) throw new NotFoundException();

    try {
      return await this.prisma.user.update({
        where: { id: userId },
        data: { fullName, phone: phone || null, address: address || null },
        select: { id: true, email: true, fullName: true, profilePhotoUrl: true, phone: true, address: true },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2022') {
        const updated = await this.prisma.user.update({
          where: { id: userId },
          data: { fullName, phone: phone || null, address: address || null },
          select: { id: true, email: true, fullName: true, phone: true, address: true },
        });
        return { ...updated, profilePhotoUrl: null };
      }
      throw e;
    }
  }

  async updateMePhoto(userId: string, profilePhotoUrl: string) {
    const url = String(profilePhotoUrl ?? '').trim();
    if (!url) throw new BadRequestException('URL de photo invalide.');
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true },
    });
    if (!user || user.role !== UserRole.PARENT) throw new NotFoundException();
    try {
      return await this.prisma.user.update({
        where: { id: userId },
        data: { profilePhotoUrl: url },
        select: { id: true, profilePhotoUrl: true },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2022') {
        throw new BadRequestException(
          'La base de données n’est pas à jour pour la photo de profil. Exécutez les migrations Prisma.',
        );
      }
      throw e;
    }
  }

  async changePassword(userId: string, body: Record<string, unknown>) {
    const currentPassword = String(body?.currentPassword ?? '');
    const newPassword = String(body?.newPassword ?? '');
    if (!currentPassword || !newPassword) {
      throw new BadRequestException('Mot de passe actuel et nouveau mot de passe requis.');
    }
    if (newPassword.length < 8) {
      throw new BadRequestException('Le nouveau mot de passe doit contenir au moins 8 caractères.');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true, passwordHash: true },
    });
    if (!user || user.role !== UserRole.PARENT || !user.passwordHash) {
      throw new NotFoundException();
    }

    const ok = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!ok) throw new BadRequestException('Mot de passe actuel incorrect.');

    const nextHash = await bcrypt.hash(newPassword, 10);
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: nextHash },
    });
    return { ok: true };
  }

  async getChildForParent(parentId: string, childId: string) {
    const ordered = await this.prisma.child.findMany({
      where: { parentId },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      select: { id: true },
    });
    const idx = ordered.findIndex((c) => c.id === childId);
    const childNumber = idx >= 0 ? idx + 1 : null;

    const child = await this.prisma.child.findFirst({
      where: { id: childId, parentId },
    });
    if (!child) throw new NotFoundException();
    return this.toChildResponse(child as ChildRow, childNumber);
  }

  async updateChild(parentId: string, childId: string, body: Record<string, unknown>) {
    const existing = await this.prisma.child.findFirst({
      where: { id: childId, parentId },
    });
    if (!existing) throw new NotFoundException();

    const data: {
      firstName?: string;
      lastName?: string;
      birthDate?: Date | null;
      gender?: Gender;
      allergies?: string | null;
    } = {};

    if (body.firstName !== undefined) {
      const firstName = String(body.firstName ?? '').trim();
      if (!firstName) throw new BadRequestException('Le prénom est obligatoire');
      data.firstName = firstName;
    }
    if (body.lastName !== undefined) {
      const lastName = String(body.lastName ?? '').trim();
      if (!lastName) throw new BadRequestException('Le nom est obligatoire');
      data.lastName = lastName;
    }
    if (body.birthDate !== undefined) {
      const raw = body.birthDate === null || body.birthDate === '' ? null : String(body.birthDate).trim();
      if (raw === null || raw === '') {
        data.birthDate = null;
      } else {
        const d = new Date(raw);
        if (Number.isNaN(d.getTime())) {
          throw new BadRequestException('Date de naissance invalide');
        }
        data.birthDate = d;
      }
    }
    if (body.gender !== undefined) {
      const g = String(body.gender ?? '').toUpperCase();
      const gender =
        g === 'FEMALE' || g === 'FILLE'
          ? Gender.FEMALE
          : g === 'MALE' || g === 'GARCON' || g === 'GARÇON'
            ? Gender.MALE
            : g === 'UNSPECIFIED' || g === '' || g === 'NON_PRECISE'
              ? Gender.UNSPECIFIED
              : null;
      if (gender === null) throw new BadRequestException('Genre invalide');
      data.gender = gender;
    }
    if (body.allergies !== undefined) {
      const a = body.allergies === null ? '' : String(body.allergies).trim();
      data.allergies = a || null;
    }

    if (Object.keys(data).length === 0) {
      return this.getChildForParent(parentId, childId);
    }

    try {
      await this.prisma.child.update({
        where: { id: childId },
        data,
      });
      return await this.getChildForParent(parentId, childId);
    } catch (e) {
      if (e instanceof NotFoundException || e instanceof BadRequestException) throw e;
      if (e instanceof Prisma.PrismaClientKnownRequestError) {
        if (e.code === 'P2022') {
          throw new BadRequestException(
            'Colonne absente en base : exécutez les migrations Prisma (npx prisma migrate deploy).',
          );
        }
        if (e.code === 'P2025') throw new NotFoundException();
        this.logger.warn(`Prisma ${e.code}: ${e.message}`);
        throw new BadRequestException(e.message);
      }
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.error(`updateChild: ${msg}`, e instanceof Error ? e.stack : undefined);
      const expose =
        process.env.NODE_ENV !== 'production' || process.env.DEBUG_PARENT === '1';
      throw new InternalServerErrorException(expose ? msg : 'Mise à jour impossible');
    }
  }

  async reenrollChild(parentId: string, childId: string, body: Record<string, unknown>) {
    const child = await this.prisma.child.findFirst({
      where: { id: childId, parentId },
      select: { id: true },
    });
    if (!child) throw new NotFoundException();

    const levelId = String(body.levelId ?? '').trim();
    if (!levelId) throw new BadRequestException('levelId est obligatoire');
    const classId = body.classId ? String(body.classId).trim() : null;
    let schoolYear = String(body.schoolYear ?? '').trim();
    if (!schoolYear) schoolYear = await this.getOpenSchoolYearLabel();

    const open = await this.prisma.schoolYear.findUnique({ where: { label: schoolYear } });
    if (!open || open.status !== SchoolYearStatus.OPEN) {
      throw new BadRequestException("L'année scolaire choisie n'est pas ouverte.");
    }

    const existing = await this.prisma.enrollment.findFirst({
      where: { childId, schoolYear },
      select: { id: true },
    });
    if (existing) {
      throw new BadRequestException('Cet enfant est déjà inscrit pour cette année scolaire.');
    }

    const closedYears = await this.prisma.schoolYear.findMany({
      where: { status: SchoolYearStatus.CLOSED },
      select: { label: true },
    });
    const closedLabels = closedYears.map((y) => y.label);
    if (closedLabels.length) {
      const [unpaidTuition, unpaidMonthly] = await Promise.all([
        this.prisma.tuitionCharge.count({
          where: {
            status: { not: 'PAID' },
            enrollment: { childId, schoolYear: { in: closedLabels } },
          },
        }),
        this.prisma.monthlyInstallment.count({
          where: {
            status: { not: 'PAID' },
            enrollment: { childId, schoolYear: { in: closedLabels } },
          },
        }),
      ]);
      if (unpaidTuition > 0 || unpaidMonthly > 0) {
        throw new BadRequestException(
          "Réinscription impossible: toutes les factures des années clôturées doivent être réglées.",
        );
      }
    }

    if (classId) {
      const cls = await this.prisma.classRoom.findFirst({
        where: { id: classId, levelId },
        select: { id: true },
      });
      if (!cls) throw new BadRequestException('Classe invalide pour le niveau choisi.');
    }

    return this.prisma.enrollment.create({
      data: {
        childId,
        levelId,
        classId,
        schoolYear,
        status: EnrollmentStatus.PENDING,
      },
      include: {
        child: true,
        level: true,
        class: true,
      },
    });
  }

  getOverview(userId: string) {
    return this.prisma.child.findMany({
      where: { parentId: userId },
      orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      include: {
        enrollments: {
          orderBy: { createdAt: 'desc' },
          include: {
            level: true,
            class: true,
          },
        },
      },
    });
  }

  async listNotifications(userId: string) {
    await this.notifications.ensureOverduePaymentNotifications(userId);
    const items = await this.prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        title: true,
        body: true,
        kind: true,
        readAt: true,
        createdAt: true,
        enrollmentId: true,
      },
    });
    const unreadCount = items.filter((n) => !n.readAt).length;
    return { items, unreadCount, latest: items[0] ?? null };
  }

  async markNotificationRead(userId: string, notificationId: string) {
    const n = await this.prisma.notification.findFirst({
      where: { id: notificationId, userId },
    });
    if (!n) throw new NotFoundException('Notification introuvable');
    return this.prisma.notification.update({
      where: { id: notificationId },
      data: { readAt: new Date() },
    });
  }

  async markAllNotificationsRead(userId: string) {
    await this.prisma.notification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { ok: true };
  }

  async listPaymentsOverview(userId: string) {
    const children = await this.prisma.child.findMany({
      where: { parentId: userId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        enrollments: { select: { id: true } },
      },
    });
    const enrollmentIds = [
      ...new Set(children.flatMap((c) => c.enrollments.map((e) => e.id))),
    ];
    const billingContact = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        fullName: true,
        email: true,
        phone: true,
        address: true,
        parentRelation: true,
      },
    });

    if (enrollmentIds.length === 0) {
      return {
        billingContact,
        payments: [],
        legacyPayments: [],
        tuitionCharges: [],
        monthlyInstallments: [],
        totalPaidCents: 0,
      };
    }

    /** Aligner scolarité + mensualités sur le barème actuel (même logique qu’après validation admin). */
    const approvedEnrollments = await this.prisma.enrollment.findMany({
      where: { id: { in: enrollmentIds }, status: EnrollmentStatus.APPROVED },
      select: { id: true },
    });
    for (const { id } of approvedEnrollments) {
      try {
        await this.billing.syncEnrollmentBilling(id);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.logger.warn(`syncEnrollmentBilling(${id}): ${msg}`);
      }
    }

    const [legacyPayments, tuitionCharges, monthlyInstallments] = await Promise.all([
      this.prisma.monthlyPayment.findMany({
        where: { enrollmentId: { in: enrollmentIds } },
        orderBy: [{ year: 'desc' }, { month: 'desc' }],
        include: {
          enrollment: {
            select: {
              id: true,
              schoolYear: true,
              createdAt: true,
              level: { select: { name: true } },
              child: { select: { firstName: true, lastName: true, allergies: true } },
            },
          },
        },
      }),
      this.prisma.tuitionCharge.findMany({
        where: { enrollmentId: { in: enrollmentIds } },
        orderBy: { schoolYear: 'desc' },
        include: {
          enrollment: {
            select: {
              id: true,
              schoolYear: true,
              createdAt: true,
              levelId: true,
              level: { select: { name: true } },
              child: { select: { firstName: true, lastName: true, allergies: true } },
            },
          },
        },
      }),
      this.prisma.monthlyInstallment.findMany({
        where: { enrollmentId: { in: enrollmentIds } },
        orderBy: [{ year: 'desc' }, { month: 'desc' }],
        include: {
          enrollment: {
            select: {
              id: true,
              schoolYear: true,
              createdAt: true,
              level: { select: { name: true } },
              child: { select: { firstName: true, lastName: true, allergies: true } },
            },
          },
          lines: true,
        },
      }),
    ]);

    const legacyPaidCents = legacyPayments
      .filter((p) => p.status === 'PAID')
      .reduce((sum, p) => sum + p.amountCents, 0);
    const tuitionPaidCents = tuitionCharges
      .filter((p) => p.status === 'PAID')
      .reduce((sum, p) => sum + p.amountCents, 0);
    const monthlyPaidCents = monthlyInstallments
      .filter((p) => p.status === 'PAID')
      .reduce((sum, p) => sum + p.totalAmountCents, 0);

    return {
      billingContact,
      legacyPayments,
      tuitionCharges,
      monthlyInstallments,
      totalPaidCents: legacyPaidCents + tuitionPaidCents + monthlyPaidCents,
    };
  }

  async listLevelDocuments(userId: string) {
    const children = await this.prisma.child.findMany({
      where: { parentId: userId },
      include: {
        enrollments: { select: { levelId: true, classId: true } },
      },
    });
    const levelIds = [
      ...new Set(children.flatMap((c) => c.enrollments.map((e) => e.levelId))),
    ];
    const classIds = [
      ...new Set(
        children.flatMap((c) => c.enrollments.map((e) => e.classId).filter((id): id is string => !!id)),
      ),
    ];

    const rows = await this.prisma.document.findMany({
      where: publishedDocumentsForParentWhere(userId, levelIds, classIds),
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        title: true,
        url: true,
        kind: true,
        requiresParentSignature: true,
      },
    });

    const requiredIds = rows.filter((d) => d.requiresParentSignature).map((d) => d.id);
    if (requiredIds.length > 0) {
      await this.prisma.documentSignature.createMany({
        data: requiredIds.map((documentId) => ({
          documentId,
          parentId: userId,
          status: DocumentSignatureStatus.PENDING,
        })),
        skipDuplicates: true,
      });
    }

    const signatures =
      requiredIds.length > 0
        ? await this.prisma.documentSignature.findMany({
            where: { parentId: userId, documentId: { in: requiredIds } },
            select: {
              documentId: true,
              status: true,
              signatureUrl: true,
              signedAt: true,
            },
          })
        : [];
    const sigByDoc = new Map(signatures.map((s) => [s.documentId, s]));

    return rows.map((d) => {
      const sig = sigByDoc.get(d.id);
      const signatureStatus = !d.requiresParentSignature
        ? 'NONE'
        : sig?.status === DocumentSignatureStatus.SIGNED
          ? 'SIGNED'
          : 'PENDING';
      return {
        id: d.id,
        title: d.title,
        url: d.url,
        kind: d.kind,
        requiresParentSignature: d.requiresParentSignature,
        signatureStatus,
        signatureUrl: sig?.signatureUrl ?? null,
        signedAt: sig?.signedAt?.toISOString() ?? null,
      };
    });
  }

  async signDocument(userId: string, documentId: string, body: Record<string, unknown>) {
    const dataUrl = String(body?.signatureDataUrl ?? '').trim();
    if (!dataUrl) throw new BadRequestException('Signature requise.');

    const docs = await this.listLevelDocuments(userId);
    const doc = docs.find((d) => d.id === documentId);
    if (!doc) throw new NotFoundException('Document introuvable.');
    if (!doc.requiresParentSignature) {
      throw new BadRequestException('Ce document ne nécessite pas de signature.');
    }
    if (doc.signatureStatus === 'SIGNED') {
      return {
        id: doc.id,
        title: doc.title,
        url: doc.url,
        kind: doc.kind,
        requiresParentSignature: true,
        signatureStatus: 'SIGNED' as const,
        signatureUrl: doc.signatureUrl,
        signedAt: doc.signedAt,
      };
    }

    const signatureUrl = saveDocumentParentSignatureFromDataUrl(documentId, userId, dataUrl);
    const now = new Date();
    const row = await this.prisma.documentSignature.upsert({
      where: {
        documentId_parentId: { documentId, parentId: userId },
      },
      create: {
        documentId,
        parentId: userId,
        status: DocumentSignatureStatus.SIGNED,
        signatureUrl,
        signedAt: now,
      },
      update: {
        status: DocumentSignatureStatus.SIGNED,
        signatureUrl,
        signedAt: now,
      },
    });

    return {
      id: doc.id,
      title: doc.title,
      url: doc.url,
      kind: doc.kind,
      requiresParentSignature: true,
      signatureStatus: 'SIGNED' as const,
      signatureUrl: row.signatureUrl,
      signedAt: row.signedAt?.toISOString() ?? now.toISOString(),
    };
  }

  private mapWorkshopForParent(
    w: {
      id: string;
      title: string;
      description: string | null;
      importantInfo: string | null;
      imageUrl: string;
      eventDate: Date;
      startTime: string;
      endTime: string;
      location: string | null;
      ageRange: string | null;
      recommendedAge: string | null;
      capacity: number;
      isFree: boolean;
      priceLabel: string | null;
      closed?: boolean;
    },
    placesUsed = 0,
  ) {
    const closed = Boolean(w.closed);
    const remaining = closed ? 0 : Math.max(0, w.capacity - placesUsed);
    return {
      id: w.id,
      title: w.title,
      description: w.description ?? '',
      importantInfo: w.importantInfo ?? '',
      image: w.imageUrl,
      date: w.eventDate.toLocaleDateString('fr-FR', {
        day: '2-digit',
        month: 'long',
        year: 'numeric',
      }),
      dateValue: w.eventDate.toISOString().slice(0, 10),
      time: `De ${w.startTime.replace(':', 'H')} à ${w.endTime.replace(':', 'H')}`,
      age: w.ageRange || w.recommendedAge || '—',
      price: w.isFree ? 'Gratuit' : w.priceLabel || '—',
      location: w.location ?? '',
      capacity: w.capacity,
      closed,
      placesRemaining: remaining,
      startTime: w.startTime,
      endTime: w.endTime,
    };
  }

  async listWorkshops() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const workshops = await this.prisma.workshop.findMany({
      where: {
        published: true,
        eventDate: { gte: today },
      },
      orderBy: [{ eventDate: 'asc' }, { startTime: 'asc' }],
    });

    const ids = workshops.map((w) => w.id);
    const bookedRows = ids.length
      ? await this.prisma.workshopReservation.groupBy({
          by: ['workshopId'],
          where: {
            workshopId: { in: ids },
            status: { not: WorkshopReservationStatus.ANNULEE },
          },
          _sum: { places: true },
        })
      : [];
    const bookedMap = new Map(bookedRows.map((r) => [r.workshopId, r._sum.places ?? 0]));

    return {
      items: workshops.map((w) => this.mapWorkshopForParent(w, bookedMap.get(w.id) ?? 0)),
    };
  }

  async getWorkshop(workshopId: string) {
    const workshop = await this.prisma.workshop.findFirst({
      where: { id: workshopId, published: true },
    });
    if (!workshop) throw new NotFoundException('Atelier introuvable.');

    const booked = await this.prisma.workshopReservation.aggregate({
      where: {
        workshopId,
        status: { not: WorkshopReservationStatus.ANNULEE },
      },
      _sum: { places: true },
    });

    return this.mapWorkshopForParent(workshop, booked._sum.places ?? 0);
  }

  async registerWorkshop(parentId: string, workshopId: string, body: Record<string, unknown>) {
    const workshop = await this.prisma.workshop.findFirst({
      where: { id: workshopId, published: true },
    });
    if (!workshop) throw new NotFoundException('Atelier introuvable.');
    if (workshop.closed) {
      throw new BadRequestException('Cet atelier est clôturé : plus aucune réservation n’est possible.');
    }

    const rawIds = body?.childIds;
    const childIds = Array.isArray(rawIds)
      ? [...new Set(rawIds.map((id) => String(id ?? '').trim()).filter(Boolean))]
      : String(body?.childId ?? '').trim()
        ? [String(body.childId).trim()]
        : [];
    if (!childIds.length) throw new BadRequestException('Sélectionnez au moins un enfant.');

    const children = await this.prisma.child.findMany({
      where: { id: { in: childIds }, parentId },
      select: { id: true, firstName: true, lastName: true, birthDate: true },
    });
    if (children.length !== childIds.length) {
      throw new NotFoundException('Un ou plusieurs enfants sont introuvables.');
    }

    const parent = await this.prisma.user.findUnique({
      where: { id: parentId },
      select: { fullName: true, email: true, phone: true },
    });
    if (!parent) throw new NotFoundException('Compte parent introuvable.');

    const booked = await this.prisma.workshopReservation.aggregate({
      where: {
        workshopId,
        status: { not: WorkshopReservationStatus.ANNULEE },
      },
      _sum: { places: true },
    });
    const used = booked._sum.places ?? 0;
    const places = Math.max(1, Math.floor(Number(body?.places ?? 1)) || 1);
    if (used + places > workshop.capacity) {
      throw new BadRequestException('Il ne reste plus assez de places pour cet atelier.');
    }

    const today = new Date();
    const ages = children.map((child) => {
      if (!child.birthDate) return null;
      let age = today.getFullYear() - child.birthDate.getFullYear();
      const m = today.getMonth() - child.birthDate.getMonth();
      if (m < 0 || (m === 0 && today.getDate() < child.birthDate.getDate())) age -= 1;
      return Math.max(0, age);
    });
    const childAge = ages.length === 1 ? ages[0] : null;
    const childName = children
      .map((c) => `${c.firstName} ${c.lastName}`.trim())
      .filter(Boolean)
      .join(', ');

    const count = await this.prisma.workshopReservation.count();
    const code = `RES-${String(count + 1).padStart(5, '0')}`;
    const parentName = parent.fullName?.trim() || parent.email;

    const reservation = await this.prisma.workshopReservation.create({
      data: {
        code,
        workshopId,
        userId: parentId,
        childName,
        childAge,
        parentName,
        parentPhone: parent.phone,
        places,
        status: WorkshopReservationStatus.EN_ATTENTE,
        accountKind: WorkshopAccountKind.PARENT,
      },
    });

    const dateLabel = workshop.eventDate.toLocaleDateString('fr-FR', {
      day: '2-digit',
      month: 'long',
      year: 'numeric',
    });
    const timeLabel = `De ${workshop.startTime.replace(':', 'H')} à ${workshop.endTime.replace(':', 'H')}`;

    await this.mail
      .sendWorkshopReservationConfirmation({
        to: parent.email,
        parentName,
        parentPhone: parent.phone,
        reservationCode: reservation.code,
        workshopTitle: workshop.title,
        workshopDateLabel: dateLabel,
        workshopTimeLabel: timeLabel,
        places,
        childName,
      })
      .catch((err) => {
        this.logger.error(
          `E-mail réservation atelier non envoyé (${reservation.code})`,
          err instanceof Error ? err.stack : err,
        );
      });

    return {
      id: reservation.id,
      code: reservation.code,
      status: reservation.status,
      workshopId,
      childName,
      places,
    };
  }

  async listMyWorkshopReservations(parentId: string) {
    const parent = await this.prisma.user.findUnique({
      where: { id: parentId },
      select: { id: true },
    });
    if (!parent) throw new NotFoundException('Compte parent introuvable.');

    // Uniquement les réservations explicitement liées à ce compte (jamais par tél. / nom).
    const mine = await this.prisma.workshopReservation.findMany({
      where: { userId: parentId },
      include: { workshop: true },
      orderBy: { reservedAt: 'desc' },
    });

    return {
      items: mine.map((r) => ({
        id: r.id,
        code: r.code,
        status: r.status,
        places: r.places,
        childName: r.childName,
        reservedAt: r.reservedAt.toISOString(),
        reservedAtLabel: r.reservedAt.toLocaleString('fr-FR', {
          day: '2-digit',
          month: 'short',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        }),
        workshop: {
          id: r.workshop.id,
          title: r.workshop.title,
          description: r.workshop.description ?? '',
          image: r.workshop.imageUrl,
          date: r.workshop.eventDate.toLocaleDateString('fr-FR', {
            day: '2-digit',
            month: 'long',
            year: 'numeric',
          }),
          dateValue: r.workshop.eventDate.toISOString().slice(0, 10),
          time: `De ${r.workshop.startTime.replace(':', 'H')} à ${r.workshop.endTime.replace(':', 'H')}`,
          age: r.workshop.ageRange || r.workshop.recommendedAge || '—',
          price: r.workshop.isFree ? 'Gratuit' : r.workshop.priceLabel || '—',
        },
      })),
    };
  }

  private async assertChildOwned(parentId: string, childId: string) {
    const child = await this.prisma.child.findFirst({
      where: { id: childId, parentId },
      select: { id: true },
    });
    if (!child) throw new NotFoundException();
    return child;
  }

  private mapFollowUpNoteForParent(note: {
    id: string;
    category: FollowUpNoteCategory;
    content: string;
    rating: number | null;
    noteDate: Date;
    createdAt: Date;
    publishedAt: Date | null;
  }) {
    return {
      id: note.id,
      category: note.category,
      content: note.content,
      rating: note.rating,
      noteDate: note.noteDate.toISOString().slice(0, 10),
      timeLabel: note.createdAt.toLocaleTimeString('fr-FR', {
        hour: '2-digit',
        minute: '2-digit',
      }),
      publishedAt: note.publishedAt?.toISOString() ?? null,
    };
  }

  private mapHealthRecordForParent(
    record: {
      id: string;
      childId: string;
      bloodGroup: string | null;
      doctorName: string | null;
      doctorPhone: string | null;
      knownAllergies: string | null;
      ongoingTreatments: string | null;
      dietaryRegime: string | null;
      instructions: string | null;
      schoolSignatureType: SchoolSignatureType | null;
      schoolSignatureText: string | null;
      schoolSignatureUrl: string | null;
      schoolSignedAt: Date | null;
      schoolSignedById: string | null;
      parentSignatureUrl: string | null;
      parentSignedAt: Date | null;
      parentSignatureRequestedAt: Date | null;
      vaccinations: {
        id: string;
        name: string;
        status: VaccinationStatus;
        vaccinatedAt: Date | null;
      }[];
    },
    schoolSignedByName: string | null,
  ) {
    const schoolSigned = Boolean(record.schoolSignedAt);
    const parentSigned = Boolean(record.parentSignedAt && record.parentSignatureUrl);
    const awaitingParent =
      !parentSigned &&
      (Boolean(record.parentSignatureRequestedAt) || schoolSigned);
    return {
      id: record.id,
      childId: record.childId,
      bloodGroup: record.bloodGroup ?? '',
      doctorName: record.doctorName ?? '',
      doctorPhone: record.doctorPhone ?? '',
      knownAllergies: record.knownAllergies ?? '',
      ongoingTreatments: record.ongoingTreatments ?? '',
      dietaryRegime: record.dietaryRegime ?? '',
      instructions: record.instructions ?? '',
      schoolSignatureType: record.schoolSignatureType,
      schoolSignatureText: record.schoolSignatureText,
      schoolSignatureUrl: record.schoolSignatureUrl,
      schoolSignedAt: record.schoolSignedAt?.toISOString() ?? null,
      schoolSignedByName,
      schoolSigned,
      parentSignatureUrl: record.parentSignatureUrl,
      parentSignedAt: record.parentSignedAt?.toISOString() ?? null,
      parentSigned,
      parentSignatureRequestedAt: record.parentSignatureRequestedAt?.toISOString() ?? null,
      awaitingParentSignature: awaitingParent,
      vaccinations: record.vaccinations.map((v) => ({
        id: v.id,
        name: v.name,
        status: v.status,
        vaccinatedAt: v.vaccinatedAt ? v.vaccinatedAt.toISOString().slice(0, 10) : null,
        dateLabel:
          v.status === VaccinationStatus.DONE && v.vaccinatedAt
            ? v.vaccinatedAt.toLocaleDateString('fr-FR', {
                day: 'numeric',
                month: 'long',
                year: 'numeric',
              })
            : null,
      })),
    };
  }

  async getChildSpace(parentId: string, childId: string) {
    await this.assertChildOwned(parentId, childId);

    const [child, parentUser, notes, healthRecord] = await Promise.all([
      this.prisma.child.findUniqueOrThrow({
        where: { id: childId },
        include: {
          enrollments: {
            orderBy: { createdAt: 'desc' },
            include: { level: true, class: true },
          },
        },
      }),
      this.prisma.user.findUnique({
        where: { id: parentId },
        select: {
          fullName: true,
          email: true,
          phone: true,
          address: true,
          parentRelation: true,
        },
      }),
      this.prisma.childFollowUpNote.findMany({
        where: { childId, status: FollowUpNoteStatus.PUBLISHED },
        orderBy: [{ noteDate: 'desc' }, { createdAt: 'desc' }],
      }),
      this.prisma.childHealthRecord.findUnique({
        where: { childId },
        include: {
          vaccinations: { orderBy: { createdAt: 'asc' } },
        },
      }),
    ]);

    const enrollment =
      child.enrollments.find((e) => e.status === EnrollmentStatus.APPROVED) ??
      child.enrollments[0] ??
      null;

    const allergiesList = splitAllergies(child.allergies);
    const parentRelLabel = parentRelationLabelFr(parentUser?.parentRelation);

    let schoolSignedByName: string | null = null;
    if (healthRecord?.schoolSignedById) {
      const signer = await this.prisma.user.findUnique({
        where: { id: healthRecord.schoolSignedById },
        select: { fullName: true },
      });
      schoolSignedByName = signer?.fullName?.trim() || null;
    }

    return {
      child: {
        id: child.id,
        firstName: child.firstName,
        lastName: child.lastName,
        fullName: `${child.firstName} ${child.lastName}`.trim(),
        birthDate: child.birthDate?.toISOString() ?? null,
        birthDisplay: child.birthDate
          ? child.birthDate.toLocaleDateString('fr-FR', {
              day: 'numeric',
              month: 'long',
              year: 'numeric',
            })
          : '—',
        gender: child.gender,
        genderLabel: genderLabelFr(child.gender),
        ageLabel: ageLabelShort(child.birthDate),
        allergies: allergiesList,
        allergiesRaw: child.allergies,
        matricule: matriculeFromChildId(child.id),
        address: parentUser?.address?.trim() || null,
      },
      enrollment: enrollment
        ? {
            id: enrollment.id,
            status: enrollment.status,
            schoolYear: enrollment.schoolYear,
            levelName: enrollment.level.name,
            className: enrollment.class?.name ?? enrollment.level.name,
            headTeacher: enrollment.class?.headTeacher?.trim() || null,
            enrollmentDate: enrollment.createdAt.toISOString(),
            enrollmentDateDisplay: enrollment.createdAt.toLocaleDateString('fr-FR', {
              day: 'numeric',
              month: 'long',
              year: 'numeric',
            }),
          }
        : null,
      parent: parentUser
        ? {
            fullName: parentUser.fullName,
            email: parentUser.email,
            phone: parentUser.phone,
            relationLabel: parentRelLabel,
          }
        : null,
      followUpNotes: {
        items: notes.map((n) => this.mapFollowUpNoteForParent(n)),
      },
      healthRecord: healthRecord
        ? this.mapHealthRecordForParent(healthRecord, schoolSignedByName)
        : null,
    };
  }

  async signChildHealthRecord(parentId: string, childId: string, body: Record<string, unknown>) {
    await this.assertChildOwned(parentId, childId);

    const record = await this.prisma.childHealthRecord.findUnique({
      where: { childId },
      include: { vaccinations: { orderBy: { createdAt: 'asc' } } },
    });
    if (!record) {
      throw new NotFoundException('Fiche santé introuvable.');
    }
    if (record.parentSignedAt && record.parentSignatureUrl) {
      throw new BadRequestException('La fiche est déjà signée.');
    }

    const signatureDataUrl = String(body?.signatureDataUrl ?? '').trim();
    if (!signatureDataUrl) {
      throw new BadRequestException('Signature requise.');
    }

    const parentSignatureUrl = saveHealthRecordParentSignatureFromDataUrl(childId, signatureDataUrl);

    const updated = await this.prisma.childHealthRecord.update({
      where: { id: record.id },
      data: {
        parentSignatureUrl,
        parentSignedAt: new Date(),
      },
      include: { vaccinations: { orderBy: { createdAt: 'asc' } } },
    });

    let schoolSignedByName: string | null = null;
    if (updated.schoolSignedById) {
      const signer = await this.prisma.user.findUnique({
        where: { id: updated.schoolSignedById },
        select: { fullName: true },
      });
      schoolSignedByName = signer?.fullName?.trim() || null;
    }

    return this.mapHealthRecordForParent(updated, schoolSignedByName);
  }

  private async ensureParentHealthRecord(parentId: string, childId: string) {
    await this.assertChildOwned(parentId, childId);
    const existing = await this.prisma.childHealthRecord.findUnique({
      where: { childId },
      include: { vaccinations: { orderBy: { createdAt: 'asc' } } },
    });
    if (existing) return existing;

    const child = await this.prisma.child.findUnique({
      where: { id: childId },
      select: { allergies: true },
    });
    return this.prisma.childHealthRecord.create({
      data: {
        childId,
        knownAllergies: child?.allergies?.trim() || null,
      },
      include: { vaccinations: { orderBy: { createdAt: 'asc' } } },
    });
  }

  private async healthRecordWithSignerName(record: {
    id: string;
    childId: string;
    bloodGroup: string | null;
    doctorName: string | null;
    doctorPhone: string | null;
    knownAllergies: string | null;
    ongoingTreatments: string | null;
    dietaryRegime: string | null;
    instructions: string | null;
    schoolSignatureType: SchoolSignatureType | null;
    schoolSignatureText: string | null;
    schoolSignatureUrl: string | null;
    schoolSignedAt: Date | null;
    schoolSignedById: string | null;
    parentSignatureUrl: string | null;
    parentSignedAt: Date | null;
    parentSignatureRequestedAt: Date | null;
    vaccinations: {
      id: string;
      name: string;
      status: VaccinationStatus;
      vaccinatedAt: Date | null;
    }[];
  }) {
    let schoolSignedByName: string | null = null;
    if (record.schoolSignedById) {
      const signer = await this.prisma.user.findUnique({
        where: { id: record.schoolSignedById },
        select: { fullName: true },
      });
      schoolSignedByName = signer?.fullName?.trim() || null;
    }
    return this.mapHealthRecordForParent(record, schoolSignedByName);
  }

  async updateChildHealthRecord(parentId: string, childId: string, body: Record<string, unknown>) {
    const record = await this.ensureParentHealthRecord(parentId, childId);
    const strField = (v: unknown) => String(v ?? '').trim() || null;

    const vaccinationsIn = body.vaccinations;
    const vaccinations = Array.isArray(vaccinationsIn)
      ? vaccinationsIn
          .map((row) => {
            const r = row as Record<string, unknown>;
            const name = String(r.name ?? '').trim();
            if (!name) return null;
            const statusRaw = String(r.status ?? 'MISSING').toUpperCase();
            const status =
              statusRaw === VaccinationStatus.DONE ? VaccinationStatus.DONE : VaccinationStatus.MISSING;
            let vaccinatedAt: Date | null = null;
            if (status === VaccinationStatus.DONE && r.vaccinatedAt) {
              const raw = String(r.vaccinatedAt).trim();
              const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
              if (m) {
                const y = Number(m[1]);
                const mo = Number(m[2]) - 1;
                const d = Number(m[3]);
                vaccinatedAt = new Date(Date.UTC(y, mo, d));
              }
            }
            return { name, status, vaccinatedAt };
          })
          .filter(Boolean) as { name: string; status: VaccinationStatus; vaccinatedAt: Date | null }[]
      : null;

    await this.prisma.$transaction(async (tx) => {
      await tx.childHealthRecord.update({
        where: { id: record.id },
        data: {
          bloodGroup: strField(body.bloodGroup),
          doctorName: strField(body.doctorName),
          doctorPhone: strField(body.doctorPhone),
          knownAllergies: strField(body.knownAllergies),
          ongoingTreatments: strField(body.ongoingTreatments),
          dietaryRegime: strField(body.dietaryRegime),
          instructions: strField(body.instructions),
        },
      });

      if (vaccinations) {
        await tx.childVaccination.deleteMany({ where: { healthRecordId: record.id } });
        if (vaccinations.length) {
          await tx.childVaccination.createMany({
            data: vaccinations.map((v) => ({
              healthRecordId: record.id,
              name: v.name,
              status: v.status,
              vaccinatedAt: v.vaccinatedAt,
            })),
          });
        }
      }
    });

    const full = await this.prisma.childHealthRecord.findUniqueOrThrow({
      where: { id: record.id },
      include: { vaccinations: { orderBy: { createdAt: 'asc' } } },
    });

    return this.healthRecordWithSignerName(full);
  }
}
