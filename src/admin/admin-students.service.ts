import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  EnrollmentStatus,
  FollowUpNoteCategory,
  FollowUpNoteStatus,
  Gender,
  ParentRelation,
  PaymentStatus,
  Prisma,
  SchoolSignatureType,
  VaccinationStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { NotificationsService } from '../notifications/notifications.service';

function formatSchoolYearLabel(schoolYear: string): string {
  const s = schoolYear.trim();
  if (s.includes('-') && s.length >= 9) return s.replace(/(\d{4})-(\d{4})/, '$1 - $2');
  return s;
}

function ageLabelDetailed(birthDate: Date | null): string {
  if (!birthDate) return '—';
  const now = new Date();
  let months =
    (now.getFullYear() - birthDate.getFullYear()) * 12 + (now.getMonth() - birthDate.getMonth());
  if (now.getDate() < birthDate.getDate()) months -= 1;
  if (months < 0) return '—';
  if (months < 12) {
    if (months === 0) return '< 1 mois';
    return `${months} mois`;
  }
  const years = Math.floor(months / 12);
  return `${years} an${years > 1 ? 's' : ''}`;
}

function matriculeFromChildId(childId: string): string {
  const compact = childId.replace(/-/g, '').toUpperCase();
  return `MD${compact.slice(0, 6)}`;
}

function parentRelationLabelFr(rel: ParentRelation | null | undefined): 'Père' | 'Mère' | null {
  if (rel === ParentRelation.FATHER) return 'Père';
  if (rel === ParentRelation.MOTHER) return 'Mère';
  return null;
}

function splitAllergies(raw: string | null | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function genderLabelFr(g: Gender): string {
  if (g === Gender.FEMALE) return 'Fille';
  if (g === Gender.MALE) return 'Garçon';
  return '—';
}

function normalizeLevelName(v: string): string {
  return v
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

@Injectable()
export class AdminStudentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly notifications: NotificationsService,
  ) {}

  private paidApprovedBase(): Prisma.EnrollmentWhereInput {
    return {
      status: EnrollmentStatus.APPROVED,
      OR: [
        { tuitionCharges: { some: { status: PaymentStatus.PAID } } },
        { monthlyInstallments: { some: { status: PaymentStatus.PAID } } },
        { payments: { some: { status: PaymentStatus.PAID } } },
      ],
    };
  }

  private paidApprovedWhere(search?: string): Prisma.EnrollmentWhereInput {
    const where: Prisma.EnrollmentWhereInput = {
      ...this.paidApprovedBase(),
    };

    const q = search?.trim();
    if (!q) return where;
    return {
      ...where,
      AND: [
        {
          OR: [
            { child: { firstName: { contains: q, mode: 'insensitive' } } },
            { child: { lastName: { contains: q, mode: 'insensitive' } } },
          ],
        },
      ],
    };
  }

  async getOverview(query: { page?: number; limit?: number; search?: string; sort?: string }) {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 10));
    const skip = (page - 1) * limit;
    const where = this.paidApprovedWhere(query.search);

    let orderBy:
      | Prisma.EnrollmentOrderByWithRelationInput
      | Prisma.EnrollmentOrderByWithRelationInput[] = { createdAt: 'desc' };
    const sort = query.sort?.trim();
    if (sort === 'date_asc') {
      orderBy = { createdAt: 'asc' };
    } else if (sort === 'name_asc') {
      orderBy = [{ child: { lastName: 'asc' } }, { child: { firstName: 'asc' } }];
    } else if (sort === 'name_desc') {
      orderBy = [{ child: { lastName: 'desc' } }, { child: { firstName: 'desc' } }];
    }

    const [total, rows, levels] = await Promise.all([
      this.prisma.enrollment.count({ where }),
      this.prisma.enrollment.findMany({
        where,
        skip,
        take: limit,
        orderBy,
        include: {
          child: true,
          level: true,
          class: true,
        },
      }),
      this.prisma.enrollment.findMany({
        where,
        select: { level: { select: { name: true } } },
      }),
    ]);

    let maternel = 0;
    let creche = 0;
    let cp = 0;
    for (const r of levels) {
      const n = normalizeLevelName(r.level.name);
      if (n === 'maternel' || n === 'maternelle') maternel += 1;
      if (n === 'creche') creche += 1;
      if (n === 'cp') cp += 1;
    }

    return {
      stats: { total, maternel, creche, cp },
      items: rows.map((e) => ({
        childId: e.childId,
        enrollmentId: e.id,
        studentName: `${e.child.firstName} ${e.child.lastName}`.trim(),
        photoUrl: e.child.photoUrl,
        age: ageLabelDetailed(e.child.birthDate),
        className: e.class?.name ?? e.level.name,
        schoolYear: formatSchoolYearLabel(e.schoolYear),
      })),
      total,
      page,
      limit,
    };
  }

  /** Profil élève : uniquement si au moins une inscription validée + payée. */
  async getProfile(childId: string) {
    const enrollment = await this.prisma.enrollment.findFirst({
      where: {
        childId,
        ...this.paidApprovedBase(),
      },
      orderBy: { createdAt: 'desc' },
      include: {
        child: { include: { parent: true } },
        level: true,
        class: true,
      },
    });

    if (!enrollment) {
      throw new NotFoundException('Élève introuvable ou non éligible');
    }

    const c = enrollment.child;
    const p = c.parent;
    const parentName =
      p?.fullName?.trim() ||
      [enrollment.pendingParentFirstName, enrollment.pendingParentLastName].filter(Boolean).join(' ').trim() ||
      null;
    const parentEmail = p?.email ?? enrollment.pendingParentEmail ?? null;
    const parentPhone = p?.phone ?? enrollment.pendingParentPhone ?? null;
    const homeAddress =
      p?.address?.trim() || enrollment.pendingParentAddress?.trim() || null;

    const allergiesList = splitAllergies(c.allergies);
    const parentRelLabel =
      parentRelationLabelFr(p?.parentRelation) ?? parentRelationLabelFr(enrollment.pendingParentRelation);

    return {
      childId: c.id,
      firstName: c.firstName,
      lastName: c.lastName,
      fullName: `${c.firstName} ${c.lastName}`.trim(),
      photoUrl: c.photoUrl,
      matricule: matriculeFromChildId(c.id),
      ageLabel: ageLabelDetailed(c.birthDate),
      birthDisplay: c.birthDate
        ? c.birthDate.toLocaleDateString('fr-FR', {
            day: '2-digit',
            month: 'long',
            year: 'numeric',
          })
        : '—',
      gender: c.gender,
      genderLabel: genderLabelFr(c.gender),
      address: homeAddress ?? '—',
      allergies: allergiesList,
      extraActivity: "Aucune pour l'instant",
      emergencyPhone: parentPhone,
      enrollment: {
        id: enrollment.id,
        levelId: enrollment.levelId,
        classId: enrollment.classId,
        className: enrollment.class?.name ?? enrollment.level.name,
        schoolYear: formatSchoolYearLabel(enrollment.schoolYear),
        schoolYearRaw: enrollment.schoolYear,
        enrollmentDate: enrollment.createdAt.toISOString(),
      },
      parent: parentName
        ? {
            fullName: parentName,
            email: parentEmail,
            phone: parentPhone,
            address: homeAddress,
            relationLabel: parentRelLabel,
          }
        : null,
    };
  }

  /** Supprime l’enfant et ses inscriptions (cascade). Même éligibilité que le profil (inscription validée + payée). */
  async deleteChild(childId: string) {
    const ok = await this.prisma.enrollment.findFirst({
      where: {
        childId,
        ...this.paidApprovedBase(),
      },
      select: { id: true },
    });
    if (!ok) {
      throw new NotFoundException('Élève introuvable ou non éligible');
    }
    await this.prisma.child.delete({ where: { id: childId } });
  }

  async listSchoolYears() {
    const rows = await this.prisma.levelSchoolYearPricing.findMany({
      select: { schoolYear: true },
      distinct: ['schoolYear'],
      orderBy: { schoolYear: 'desc' },
    });
    return { schoolYears: rows.map((r) => r.schoolYear) };
  }

  async updateChild(childId: string, body: Record<string, unknown>) {
    const enrollment = await this.prisma.enrollment.findFirst({
      where: {
        childId,
        ...this.paidApprovedBase(),
      },
      orderBy: { createdAt: 'desc' },
      include: {
        child: { include: { parent: true } },
      },
    });

    if (!enrollment) {
      throw new NotFoundException('Élève introuvable ou non éligible');
    }

    const firstName = String(body.firstName ?? '').trim();
    const lastName = String(body.lastName ?? '').trim();
    if (!firstName || !lastName) {
      throw new BadRequestException('Le nom et le prénom sont obligatoires.');
    }

    const levelId = String(body.levelId ?? '').trim();
    const schoolYear = String(body.schoolYear ?? '').trim();
    if (!levelId || !schoolYear) {
      throw new BadRequestException('Le niveau et l’année scolaire sont obligatoires.');
    }

    const level = await this.prisma.level.findUnique({ where: { id: levelId } });
    if (!level) {
      throw new BadRequestException('Niveau invalide.');
    }

    const classIdRaw = body.classId;
    let classId: string | null =
      classIdRaw === null || classIdRaw === undefined || classIdRaw === ''
        ? null
        : String(classIdRaw).trim();
    if (classId) {
      const cls = await this.prisma.classRoom.findFirst({
        where: { id: classId, levelId },
      });
      if (!cls) {
        throw new BadRequestException('Classe invalide pour ce niveau.');
      }
    }

    const allergiesIn = body.allergies;
    const allergiesRaw = Array.isArray(allergiesIn)
      ? allergiesIn
          .map((a) => String(a ?? '').trim())
          .filter(Boolean)
          .join('\n')
      : String(allergiesIn ?? '')
          .split(/[\n,;]+/)
          .map((s) => s.trim())
          .filter(Boolean)
          .join('\n');

    const emergencyPhone =
      body.emergencyPhone === null || body.emergencyPhone === undefined
        ? null
        : String(body.emergencyPhone).trim() || null;

    const parent = enrollment.child.parent;

    await this.prisma.$transaction(async (tx) => {
      await tx.child.update({
        where: { id: childId },
        data: {
          firstName,
          lastName,
          allergies: allergiesRaw || null,
        },
      });

      await tx.enrollment.update({
        where: { id: enrollment.id },
        data: {
          levelId,
          schoolYear,
          classId,
          ...(parent ? {} : { pendingParentPhone: emergencyPhone }),
        },
      });

      if (parent) {
        await tx.user.update({
          where: { id: parent.id },
          data: { phone: emergencyPhone },
        });
      }
    });

    return this.getProfile(childId);
  }

  async updatePhoto(childId: string, photoUrl: string) {
    const url = String(photoUrl ?? '').trim();
    if (!url) throw new BadRequestException('URL de photo invalide.');
    await this.assertEligibleChild(childId);
    const child = await this.prisma.child.update({
      where: { id: childId },
      data: { photoUrl: url },
      select: { id: true, photoUrl: true },
    });
    return { photoUrl: child.photoUrl };
  }

  private async assertEligibleChild(childId: string) {
    const ok = await this.prisma.enrollment.findFirst({
      where: {
        childId,
        ...this.paidApprovedBase(),
      },
      select: { id: true },
    });
    if (!ok) {
      throw new NotFoundException('Élève introuvable ou non éligible');
    }
  }

  private mapFollowUpNote(note: {
    id: string;
    category: FollowUpNoteCategory;
    content: string;
    rating: number | null;
    status: FollowUpNoteStatus;
    noteDate: Date;
    createdAt: Date;
    publishedAt: Date | null;
  }) {
    return {
      id: note.id,
      category: note.category,
      content: note.content,
      rating: note.rating,
      status: note.status,
      noteDate: note.noteDate.toISOString().slice(0, 10),
      timeLabel: note.createdAt.toLocaleTimeString('fr-FR', {
        hour: '2-digit',
        minute: '2-digit',
      }),
      createdAt: note.createdAt.toISOString(),
      publishedAt: note.publishedAt?.toISOString() ?? null,
    };
  }

  private parseFollowUpCategory(raw: unknown): FollowUpNoteCategory {
    const v = String(raw ?? '').trim().toUpperCase();
    const allowed = Object.values(FollowUpNoteCategory) as string[];
    if (!allowed.includes(v)) {
      throw new BadRequestException('Catégorie de note invalide.');
    }
    return v as FollowUpNoteCategory;
  }

  private parseFollowUpRating(raw: unknown): number {
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 5) {
      throw new BadRequestException('La note doit être entre 1 et 5 étoiles.');
    }
    return n;
  }

  private parseNoteDate(raw: unknown): Date {
    if (raw === undefined || raw === null || raw === '') {
      const now = new Date();
      return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
    }
    const s = String(raw).trim();
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) {
      throw new BadRequestException('Date de note invalide (format AAAA-MM-JJ).');
    }
    const y = Number(m[1]);
    const mo = Number(m[2]) - 1;
    const d = Number(m[3]);
    const dt = new Date(Date.UTC(y, mo, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo || dt.getUTCDate() !== d) {
      throw new BadRequestException('Date de note invalide.');
    }
    return dt;
  }

  async listFollowUpNotes(childId: string) {
    await this.assertEligibleChild(childId);
    const notes = await this.prisma.childFollowUpNote.findMany({
      where: { childId },
      orderBy: [{ noteDate: 'desc' }, { createdAt: 'desc' }],
    });
    const draftCount = notes.filter((n) => n.status === FollowUpNoteStatus.DRAFT).length;
    const publishedCount = notes.filter((n) => n.status === FollowUpNoteStatus.PUBLISHED).length;
    return {
      items: notes.map((n) => this.mapFollowUpNote(n)),
      stats: { draftCount, publishedCount },
    };
  }

  async createFollowUpNote(childId: string, authorId: string, body: Record<string, unknown>) {
    await this.assertEligibleChild(childId);
    const category = this.parseFollowUpCategory(body.category);
    const rating = this.parseFollowUpRating(body.rating);
    const content = String(body.content ?? '').trim();
    const noteDate = this.parseNoteDate(body.noteDate);
    const note = await this.prisma.childFollowUpNote.create({
      data: {
        childId,
        category,
        rating,
        content,
        noteDate,
        authorId,
        status: FollowUpNoteStatus.PUBLISHED,
        publishedAt: new Date(),
      },
    });
    return this.mapFollowUpNote(note);
  }

  async updateFollowUpNote(childId: string, noteId: string, body: Record<string, unknown>) {
    await this.assertEligibleChild(childId);
    const existing = await this.prisma.childFollowUpNote.findFirst({
      where: { id: noteId, childId },
    });
    if (!existing) {
      throw new NotFoundException('Note introuvable.');
    }

    const data: Prisma.ChildFollowUpNoteUpdateInput = {};

    if (body.category !== undefined) {
      data.category = this.parseFollowUpCategory(body.category);
    }
    if (body.rating !== undefined) {
      data.rating = this.parseFollowUpRating(body.rating);
    }
    if (body.content !== undefined) {
      data.content = String(body.content).trim();
    }
    if (body.status !== undefined) {
      const status = String(body.status).trim().toUpperCase();
      if (status === FollowUpNoteStatus.PUBLISHED) {
        data.status = FollowUpNoteStatus.PUBLISHED;
        data.publishedAt = new Date();
      } else if (status === FollowUpNoteStatus.DRAFT) {
        data.status = FollowUpNoteStatus.DRAFT;
        data.publishedAt = null;
      } else {
        throw new BadRequestException('Statut de note invalide.');
      }
    }

    if (!Object.keys(data).length) {
      throw new BadRequestException('Aucune modification fournie.');
    }

    const note = await this.prisma.childFollowUpNote.update({
      where: { id: noteId },
      data,
    });
    return this.mapFollowUpNote(note);
  }

  async deleteFollowUpNote(childId: string, noteId: string) {
    await this.assertEligibleChild(childId);
    const existing = await this.prisma.childFollowUpNote.findFirst({
      where: { id: noteId, childId },
      select: { id: true },
    });
    if (!existing) {
      throw new NotFoundException('Note introuvable.');
    }
    await this.prisma.childFollowUpNote.delete({ where: { id: noteId } });
  }

  async publishFollowUpDay(childId: string, noteDateRaw: unknown) {
    await this.assertEligibleChild(childId);
    const noteDate = this.parseNoteDate(noteDateRaw);
    await this.prisma.childFollowUpNote.updateMany({
      where: {
        childId,
        noteDate,
        status: FollowUpNoteStatus.DRAFT,
      },
      data: {
        status: FollowUpNoteStatus.PUBLISHED,
        publishedAt: new Date(),
      },
    });
    return this.listFollowUpNotes(childId);
  }

  private mapHealthRecord(record: {
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
    const schoolSigned = Boolean(record.schoolSignedAt);
    const parentSigned = Boolean(record.parentSignedAt && record.parentSignatureUrl);
    const isValid = schoolSigned && parentSigned;
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
      schoolSigned: schoolSigned,
      parentSignatureUrl: record.parentSignatureUrl,
      parentSignedAt: record.parentSignedAt?.toISOString() ?? null,
      parentSigned: parentSigned,
      parentSignatureRequestedAt: record.parentSignatureRequestedAt?.toISOString() ?? null,
      isValid,
      statusLabel: isValid ? 'Fiche validée' : 'En attente de signature',
      vaccinations: record.vaccinations.map((v) => ({
        id: v.id,
        name: v.name,
        status: v.status,
        vaccinatedAt: v.vaccinatedAt ? v.vaccinatedAt.toISOString().slice(0, 10) : null,
        dateLabel:
          v.status === VaccinationStatus.DONE && v.vaccinatedAt
            ? v.vaccinatedAt.toLocaleDateString('fr-FR', {
                day: '2-digit',
                month: '2-digit',
                year: 'numeric',
              })
            : null,
      })),
    };
  }

  private async ensureHealthRecord(childId: string) {
    await this.assertEligibleChild(childId);
    const existing = await this.prisma.childHealthRecord.findUnique({
      where: { childId },
      include: { vaccinations: { orderBy: { createdAt: 'asc' } } },
    });
    if (existing) return existing;

    const child = await this.prisma.child.findUnique({
      where: { id: childId },
      select: { allergies: true },
    });
    const created = await this.prisma.childHealthRecord.create({
      data: {
        childId,
        knownAllergies: child?.allergies?.trim() || null,
      },
      include: { vaccinations: { orderBy: { createdAt: 'asc' } } },
    });
    return created;
  }

  async getHealthRecord(childId: string) {
    const record = await this.ensureHealthRecord(childId);
    const full = await this.prisma.childHealthRecord.findUniqueOrThrow({
      where: { id: record.id },
      include: { vaccinations: { orderBy: { createdAt: 'asc' } } },
    });
    return this.mapHealthRecord(full);
  }

  async updateHealthRecord(childId: string, body: Record<string, unknown>) {
    const record = await this.ensureHealthRecord(childId);
    const str = (v: unknown) => (v === undefined ? undefined : String(v ?? '').trim() || null);

    const vaccinationsIn = body.vaccinations;
    const vaccinations = Array.isArray(vaccinationsIn)
      ? vaccinationsIn.map((row) => {
          const r = row as Record<string, unknown>;
          const name = String(r.name ?? '').trim();
          if (!name) return null;
          const statusRaw = String(r.status ?? 'MISSING').toUpperCase();
          const status =
            statusRaw === VaccinationStatus.DONE ? VaccinationStatus.DONE : VaccinationStatus.MISSING;
          let vaccinatedAt: Date | null = null;
          if (status === VaccinationStatus.DONE && r.vaccinatedAt) {
            vaccinatedAt = this.parseNoteDate(r.vaccinatedAt);
          }
          return { name, status, vaccinatedAt };
        }).filter(Boolean) as { name: string; status: VaccinationStatus; vaccinatedAt: Date | null }[]
      : null;

    await this.prisma.$transaction(async (tx) => {
      await tx.childHealthRecord.update({
        where: { id: record.id },
        data: {
          bloodGroup: str(body.bloodGroup),
          doctorName: str(body.doctorName),
          doctorPhone: str(body.doctorPhone),
          knownAllergies: str(body.knownAllergies),
          ongoingTreatments: str(body.ongoingTreatments),
          dietaryRegime: str(body.dietaryRegime),
          instructions: str(body.instructions),
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

    return this.getHealthRecord(childId);
  }

  async signSchoolHealthRecord(
    childId: string,
    adminUserId: string,
    body: Record<string, unknown>,
    signatureImageUrl?: string,
  ) {
    const record = await this.ensureHealthRecord(childId);
    const typeRaw = String(body.type ?? '').trim().toUpperCase();

    if (
      typeRaw === SchoolSignatureType.IMAGE ||
      typeRaw === SchoolSignatureType.HANDWRITTEN
    ) {
      const url = String(signatureImageUrl ?? body.signatureUrl ?? '').trim();
      if (!url) {
        throw new BadRequestException('Image de signature requise.');
      }
      await this.prisma.childHealthRecord.update({
        where: { id: record.id },
        data: {
          schoolSignatureType:
            typeRaw === SchoolSignatureType.HANDWRITTEN
              ? SchoolSignatureType.HANDWRITTEN
              : SchoolSignatureType.IMAGE,
          schoolSignatureText: null,
          schoolSignatureUrl: url,
          schoolSignedAt: new Date(),
          schoolSignedById: adminUserId,
        },
      });
    } else if (typeRaw === SchoolSignatureType.CALLIGRAPHY) {
      const text = String(body.text ?? '').trim();
      if (!text) {
        throw new BadRequestException('Saisissez le texte de la signature.');
      }
      await this.prisma.childHealthRecord.update({
        where: { id: record.id },
        data: {
          schoolSignatureType: SchoolSignatureType.CALLIGRAPHY,
          schoolSignatureText: text,
          schoolSignatureUrl: null,
          schoolSignedAt: new Date(),
          schoolSignedById: adminUserId,
        },
      });
    } else {
      throw new BadRequestException('Type de signature invalide.');
    }

    return this.getHealthRecord(childId);
  }

  async requestParentHealthSignature(childId: string) {
    const record = await this.ensureHealthRecord(childId);
    const child = await this.prisma.child.findUnique({
      where: { id: childId },
      select: {
        parentId: true,
        firstName: true,
        lastName: true,
        parent: { select: { email: true, fullName: true, phone: true } },
      },
    });
    if (!child?.parentId) {
      throw new BadRequestException('Aucun parent lié à cet élève.');
    }
    const parentEmail = child.parent?.email?.trim();
    if (!parentEmail) {
      throw new BadRequestException('Le parent n’a pas d’adresse e-mail.');
    }

    await this.prisma.childHealthRecord.update({
      where: { id: record.id },
      data: { parentSignatureRequestedAt: new Date() },
    });

    const name = `${child.firstName} ${child.lastName}`.trim();

    await this.notifications.notifyHealthSignatureRequest(child.parentId, childId, name);
    await this.mail.sendHealthSignatureRequest({
      to: parentEmail,
      parentName: child.parent?.fullName ?? null,
      parentPhone: child.parent?.phone ?? null,
      childName: name,
    });

    return this.getHealthRecord(childId);
  }
}
