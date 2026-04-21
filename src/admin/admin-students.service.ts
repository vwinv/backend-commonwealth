import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { EnrollmentStatus, Gender, ParentRelation, PaymentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

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
  constructor(private readonly prisma: PrismaService) {}

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
}
