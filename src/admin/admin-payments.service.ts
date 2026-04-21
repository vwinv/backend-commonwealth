import { Injectable } from '@nestjs/common';
import { PaymentStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

function formatSchoolYearLabel(schoolYear: string): string {
  const s = schoolYear.trim();
  if (s.includes('-') && s.length >= 9) return s.replace(/(\d{4})-(\d{4})/, '$1 - $2');
  return s;
}

function statusLabelFr(s: PaymentStatus): string {
  switch (s) {
    case PaymentStatus.PAID:
      return 'Validé';
    case PaymentStatus.PENDING:
      return 'En attente';
    case PaymentStatus.FAILED:
      return 'Rejeté';
    case PaymentStatus.CANCELLED:
      return 'Annulé';
    default:
      return s;
  }
}

type RowKind = 'tuition' | 'monthly';
function isLegacyTuitionRef(ref: string | null | undefined): boolean {
  if (!ref) return false;
  return ref.trim().toUpperCase().endsWith('-T');
}

@Injectable()
export class AdminPaymentsService {
  constructor(private readonly prisma: PrismaService) {}

  async getOverview(query: { page?: number; limit?: number; search?: string; sort?: string }) {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 10));
    const search = query.search?.trim();

    const [tuitionAgg, monthlyAgg, legacyTuitionAgg, legacyMonthlyAgg] = await Promise.all([
      this.prisma.tuitionCharge.aggregate({
        where: { status: PaymentStatus.PAID },
        _sum: { amountCents: true },
      }),
      this.prisma.monthlyInstallment.aggregate({
        where: { status: PaymentStatus.PAID },
        _sum: { totalAmountCents: true },
      }),
      this.prisma.monthlyPayment.aggregate({
        where: {
          status: PaymentStatus.PAID,
          transactionRef: { endsWith: '-T', mode: 'insensitive' },
        },
        _sum: { amountCents: true },
      }),
      this.prisma.monthlyPayment.aggregate({
        where: {
          status: PaymentStatus.PAID,
          NOT: {
            transactionRef: { endsWith: '-T', mode: 'insensitive' },
          },
        },
        _sum: { amountCents: true },
      }),
    ]);

    const totalInscriptionsCents =
      (tuitionAgg._sum.amountCents ?? 0) + (legacyTuitionAgg._sum.amountCents ?? 0);
    const totalMensualitesCents =
      (monthlyAgg._sum.totalAmountCents ?? 0) + (legacyMonthlyAgg._sum.amountCents ?? 0);
    const soldeTotalCents = totalInscriptionsCents + totalMensualitesCents;

    const [tuitionList, monthlyList, legacyList] = await Promise.all([
      this.prisma.tuitionCharge.findMany({
        include: {
          enrollment: {
            include: {
              child: true,
              level: true,
              class: true,
            },
          },
        },
        orderBy: { updatedAt: 'desc' },
      }),
      this.prisma.monthlyInstallment.findMany({
        include: {
          enrollment: {
            include: {
              child: true,
              level: true,
              class: true,
            },
          },
        },
        orderBy: { updatedAt: 'desc' },
      }),
      this.prisma.monthlyPayment.findMany({
        include: {
          enrollment: {
            include: {
              child: true,
              level: true,
              class: true,
            },
          },
        },
        orderBy: { updatedAt: 'desc' },
      }),
    ]);

    const q = search?.toLowerCase();
    const nameMatch = (first: string, last: string) => {
      if (!q) return true;
      const full = `${first} ${last}`.toLowerCase();
      return full.includes(q) || first.toLowerCase().includes(q) || last.toLowerCase().includes(q);
    };

    type Merged = {
      id: string;
      kind: RowKind;
      studentName: string;
      paymentMethod: string;
      className: string;
      schoolYear: string;
      status: PaymentStatus;
      statusLabel: string;
      amountCents: number;
      sortDate: Date;
    };

    const merged: Merged[] = [];

    for (const t of tuitionList) {
      const c = t.enrollment.child;
      if (!nameMatch(c.firstName, c.lastName)) continue;
      merged.push({
        id: `tuition:${t.id}`,
        kind: 'tuition',
        studentName: `${c.firstName} ${c.lastName}`.trim(),
        paymentMethod: t.transactionRef?.trim() ? 'Réf. transaction' : '—',
        className: t.enrollment.class?.name ?? t.enrollment.level.name,
        schoolYear: formatSchoolYearLabel(t.schoolYear),
        status: t.status,
        statusLabel: statusLabelFr(t.status),
        amountCents: t.amountCents,
        sortDate: t.updatedAt,
      });
    }

    for (const m of monthlyList) {
      const c = m.enrollment.child;
      if (!nameMatch(c.firstName, c.lastName)) continue;
      merged.push({
        id: `monthly:${m.id}`,
        kind: 'monthly',
        studentName: `${c.firstName} ${c.lastName}`.trim(),
        paymentMethod: m.transactionRef?.trim() ? 'Réf. transaction' : '—',
        className: m.enrollment.class?.name ?? m.enrollment.level.name,
        schoolYear: formatSchoolYearLabel(m.enrollment.schoolYear),
        status: m.status,
        statusLabel: statusLabelFr(m.status),
        amountCents: m.totalAmountCents,
        sortDate: m.updatedAt,
      });
    }
    for (const l of legacyList) {
      const c = l.enrollment.child;
      if (!nameMatch(c.firstName, c.lastName)) continue;
      const inferredKind: RowKind = isLegacyTuitionRef(l.transactionRef) ? 'tuition' : 'monthly';
      merged.push({
        id: `legacy:${l.id}`,
        kind: inferredKind,
        studentName: `${c.firstName} ${c.lastName}`.trim(),
        paymentMethod: l.transactionRef?.trim() ? 'Réf. transaction' : '—',
        className: l.enrollment.class?.name ?? l.enrollment.level.name,
        schoolYear: formatSchoolYearLabel(l.enrollment.schoolYear),
        status: l.status,
        statusLabel: statusLabelFr(l.status),
        amountCents: l.amountCents,
        sortDate: l.updatedAt,
      });
    }

    const sort = query.sort?.trim() ?? 'date_desc';
    merged.sort((a, b) => {
      if (sort === 'name_asc') {
        return a.studentName.localeCompare(b.studentName, 'fr');
      }
      if (sort === 'name_desc') {
        return b.studentName.localeCompare(a.studentName, 'fr');
      }
      if (sort === 'amount_desc') {
        return b.amountCents - a.amountCents;
      }
      if (sort === 'date_asc') {
        return a.sortDate.getTime() - b.sortDate.getTime();
      }
      return b.sortDate.getTime() - a.sortDate.getTime();
    });

    const total = merged.length;
    const skip = (page - 1) * limit;
    const slice = merged.slice(skip, skip + limit);

    return {
      stats: {
        totalInscriptionsCents,
        totalMensualitesCents,
        soldeTotalCents,
      },
      items: slice.map(({ sortDate: _s, ...rest }) => rest),
      total,
      page,
      limit,
    };
  }
}
