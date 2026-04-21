import { Injectable } from '@nestjs/common';
import { PaymentStatus, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

function ageLabel(birthDate: Date | null): string {
  if (!birthDate) return '—';
  const now = new Date();
  let years = now.getFullYear() - birthDate.getFullYear();
  const m = now.getMonth() - birthDate.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < birthDate.getDate())) {
    years--;
  }
  if (years < 0) return '—';
  return years === 0 ? '< 1 an' : `${years} an${years > 1 ? 's' : ''}`;
}

function formatSchoolYearLabel(schoolYear: string): string {
  const s = schoolYear.trim();
  if (s.includes('-') && s.length >= 9) return s.replace(/(\d{4})-(\d{4})/, '$1 - $2');
  return s;
}

function monthKeyLocal(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** 12 mois glissants (du plus ancien au plus récent) : libellés + comptes créations parents / élèves */
async function buildMonthlyChartSeries(
  prisma: PrismaService,
): Promise<{
  monthLabels: string[];
  parentsPerMonth: number[];
  studentsPerMonth: number[];
}> {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - 11, 1, 0, 0, 0, 0);

  const monthKeys: string[] = [];
  const monthLabels: string[] = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    monthKeys.push(monthKeyLocal(d));
    monthLabels.push(
      d.toLocaleDateString('fr-FR', { month: 'short' }).replace('.', ''),
    );
  }

  const parentsCounts = new Map<string, number>();
  const studentsCounts = new Map<string, number>();
  for (const k of monthKeys) {
    parentsCounts.set(k, 0);
    studentsCounts.set(k, 0);
  }

  const [parentsRaw, childrenRaw] = await Promise.all([
    prisma.user.findMany({
      where: { role: UserRole.PARENT, createdAt: { gte: start } },
      select: { createdAt: true },
    }),
    prisma.child.findMany({
      where: { createdAt: { gte: start } },
      select: { createdAt: true },
    }),
  ]);

  for (const u of parentsRaw) {
    const k = monthKeyLocal(u.createdAt);
    if (parentsCounts.has(k)) {
      parentsCounts.set(k, (parentsCounts.get(k) ?? 0) + 1);
    }
  }
  for (const c of childrenRaw) {
    const k = monthKeyLocal(c.createdAt);
    if (studentsCounts.has(k)) {
      studentsCounts.set(k, (studentsCounts.get(k) ?? 0) + 1);
    }
  }

  return {
    monthLabels,
    parentsPerMonth: monthKeys.map((k) => parentsCounts.get(k) ?? 0),
    studentsPerMonth: monthKeys.map((k) => studentsCounts.get(k) ?? 0),
  };
}

@Injectable()
export class AdminDashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async getDashboard() {
    const [
      totalEnrollments,
      totalStudents,
      totalParents,
      tuitionPaidSum,
      monthlyPaidSum,
      recentEnrollments,
      chart,
    ] = await Promise.all([
      this.prisma.enrollment.count(),
      this.prisma.child.count(),
      this.prisma.user.count({ where: { role: UserRole.PARENT } }),
      this.prisma.tuitionCharge.aggregate({
        where: { status: PaymentStatus.PAID },
        _sum: { amountCents: true },
      }),
      this.prisma.monthlyInstallment.aggregate({
        where: { status: PaymentStatus.PAID },
        _sum: { totalAmountCents: true },
      }),
      this.prisma.enrollment.findMany({
        take: 12,
        orderBy: { createdAt: 'desc' },
        include: {
          child: true,
          level: true,
          class: true,
        },
      }),
      buildMonthlyChartSeries(this.prisma),
    ]);

    const totalTuitionPaidCents =
      (tuitionPaidSum._sum.amountCents ?? 0) + (monthlyPaidSum._sum.totalAmountCents ?? 0);

    const recent = recentEnrollments.map((e) => ({
      id: e.id,
      date: e.createdAt.toISOString(),
      studentName: `${e.child.firstName} ${e.child.lastName}`.trim(),
      age: ageLabel(e.child.birthDate),
      className: e.class?.name ?? e.level.name,
      schoolYear: formatSchoolYearLabel(e.schoolYear),
    }));

    return {
      stats: {
        totalEnrollments,
        totalStudents,
        totalParents,
        totalTuitionPaidCents,
      },
      recentEnrollments: recent,
      chart,
    };
  }
}
