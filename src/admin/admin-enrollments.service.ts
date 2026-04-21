import { Injectable } from '@nestjs/common';
import { EnrollmentStatus, Prisma } from '@prisma/client';
import { EnrollmentsService } from '../enrollments/enrollments.service';
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

@Injectable()
export class AdminEnrollmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly enrollmentsCore: EnrollmentsService,
  ) {}

  async getStats() {
    const [total, pending, approved, rejected] = await Promise.all([
      this.prisma.enrollment.count(),
      this.prisma.enrollment.count({ where: { status: EnrollmentStatus.PENDING } }),
      this.prisma.enrollment.count({ where: { status: EnrollmentStatus.APPROVED } }),
      this.prisma.enrollment.count({ where: { status: EnrollmentStatus.REJECTED } }),
    ]);
    return { total, pending, approved, rejected };
  }

  async listPage(params: {
    page: number;
    limit: number;
    search?: string;
    sort?: string;
  }) {
    const page = Math.max(1, params.page);
    const limit = Math.min(100, Math.max(1, params.limit));
    const skip = (page - 1) * limit;

    const search = params.search?.trim();
    const where: Prisma.EnrollmentWhereInput = {};
    if (search) {
      where.OR = [
        { child: { firstName: { contains: search, mode: 'insensitive' } } },
        { child: { lastName: { contains: search, mode: 'insensitive' } } },
      ];
    }

    let orderBy:
      | Prisma.EnrollmentOrderByWithRelationInput
      | Prisma.EnrollmentOrderByWithRelationInput[] = { createdAt: 'desc' };
    const sort = params.sort?.trim();
    if (sort === 'date_asc') {
      orderBy = { createdAt: 'asc' };
    } else if (sort === 'name_asc') {
      orderBy = [
        { child: { lastName: 'asc' } },
        { child: { firstName: 'asc' } },
      ];
    } else if (sort === 'name_desc') {
      orderBy = [
        { child: { lastName: 'desc' } },
        { child: { firstName: 'desc' } },
      ];
    }

    const [totalFiltered, rows] = await Promise.all([
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
    ]);

    const items = rows.map((e) => ({
      id: e.id,
      date: e.createdAt.toISOString(),
      studentName: `${e.child.firstName} ${e.child.lastName}`.trim(),
      age: ageLabelDetailed(e.child.birthDate),
      className: e.class?.name ?? e.level.name,
      schoolYear: formatSchoolYearLabel(e.schoolYear),
      status: e.status,
    }));

    return {
      items,
      total: totalFiltered,
      page,
      limit,
    };
  }

  /** Stats + page en un appel (écran Gestion des inscriptions). */
  async getOverview(query: {
    page?: number;
    limit?: number;
    search?: string;
    sort?: string;
  }) {
    const [stats, pageData] = await Promise.all([
      this.getStats(),
      this.listPage({
        page: query.page ?? 1,
        limit: query.limit ?? 10,
        search: query.search,
        sort: query.sort,
      }),
    ]);
    return { stats, ...pageData };
  }

  /** Détail inscription + cartes KPI (écran suivi). */
  async getOneWithStats(id: string) {
    const [stats, enrollment] = await Promise.all([
      this.getStats(),
      this.enrollmentsCore.getOne(id),
    ]);
    return { stats, enrollment };
  }
}
