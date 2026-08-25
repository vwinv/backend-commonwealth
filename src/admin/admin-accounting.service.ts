import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  CashSessionStatus,
  EnrollmentStatus,
  MonthlyBillingLineKind,
  PaymentStatus,
} from '@prisma/client';
import {
  invoiceNumberMatchesSearch,
  normalizeInvoiceSearchQuery,
  stableInvoiceNumber,
} from '../common/invoice-number';
import { buildCashTransactionRef, formatPaymentModeFromTransactionRef } from '../common/payment-mode';
import { PaymentsService } from '../payments/payments.service';
import { PrismaService } from '../prisma/prisma.service';

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

function monthBounds(year: number, month: number) {
  const start = new Date(year, month - 1, 1, 0, 0, 0, 0);
  const end = new Date(year, month, 0, 23, 59, 59, 999);
  return { start, end };
}

function previousMonth(year: number, month: number) {
  if (month === 1) return { year: year - 1, month: 12 };
  return { year, month: month - 1 };
}

function isLegacyTuitionRef(ref: string | null | undefined): boolean {
  return Boolean(ref?.trim().toUpperCase().endsWith('-T'));
}

function monthLabelFr(month: number): string {
  const d = new Date(2000, month - 1, 1);
  return new Intl.DateTimeFormat('fr-FR', { month: 'long' }).format(d);
}

type UnpaidBillKind = 'tuition' | 'monthly' | 'legacy';

function parseCashBillId(billId: string): { kind: UnpaidBillKind; id: string } {
  const raw = String(billId ?? '').trim();
  const m = raw.match(/^(tuition|monthly|legacy):([0-9a-f-]{36})$/i);
  if (!m) throw new BadRequestException('Identifiant de facture invalide.');
  return { kind: m[1]!.toLowerCase() as UnpaidBillKind, id: m[2]! };
}

/** Paiements validés depuis l’ouverture de caisse (paidAt ou, à défaut, updatedAt). */
function paidSinceFilter(since: Date) {
  return {
    status: PaymentStatus.PAID,
    OR: [{ paidAt: { gte: since } }, { paidAt: null, updatedAt: { gte: since } }],
  };
}

function effectivePaidAt(paidAt: Date | null | undefined, updatedAt: Date): Date {
  return paidAt ?? updatedAt;
}

function paidInRange(paidAt: Date | null | undefined, start: Date, end: Date): boolean {
  if (!paidAt) return false;
  const t = paidAt.getTime();
  return t >= start.getTime() && t <= end.getTime();
}

/** Date d’encaissement plateforme (paidAt ou, à défaut, mise à jour du statut). */
function paidInCalendarMonth(
  paidAt: Date | null | undefined,
  updatedAt: Date,
  start: Date,
  end: Date,
): boolean {
  const t = (paidAt ?? updatedAt).getTime();
  return t >= start.getTime() && t <= end.getTime();
}

/** Filtre Prisma : facture payée (scolarité ou mensualité) sur une période calendaire. */
function paidInMonthFilter(start: Date, end: Date) {
  return {
    status: PaymentStatus.PAID,
    OR: [
      { paidAt: { gte: start, lte: end } },
      { paidAt: null, updatedAt: { gte: start, lte: end } },
    ],
  };
}

type TxRow = {
  id: string;
  date: string;
  studentName: string;
  className: string;
  services: string[];
  amountCents: number;
  paymentMethod: string;
  status: PaymentStatus;
  statusLabel: string;
  sortDate: Date;
};

@Injectable()
export class AdminAccountingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentsService,
  ) {}

  async getOverview(query: {
    page?: number;
    limit?: number;
    search?: string;
    service?: string;
    year?: number;
    month?: number;
  }) {
    const now = new Date();
    const year = query.year ?? now.getFullYear();
    const month = query.month ?? now.getMonth() + 1;
    const { start: monthStart, end: monthEnd } = monthBounds(year, month);
    const prev = previousMonth(year, month);
    const { start: prevStart, end: prevEnd } = monthBounds(prev.year, prev.month);

    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 10));
    const search = query.search?.trim().toLowerCase();
    const serviceFilter = query.service?.trim();

    const monthLabel = new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric' }).format(
      monthStart,
    );

    const [
      tuitionAll,
      monthlyAll,
      legacyAll,
      openSession,
      reminderCount,
      serviceBreakdownData,
    ] = await Promise.all([
      this.prisma.tuitionCharge.findMany({
        include: {
          enrollment: { include: { child: true, level: true, class: true } },
        },
      }),
      this.prisma.monthlyInstallment.findMany({
        include: {
          enrollment: { include: { child: true, level: true, class: true } },
          lines: { include: { serviceTariff: true } },
        },
      }),
      this.prisma.monthlyPayment.findMany({
        include: {
          enrollment: { include: { child: true, level: true, class: true } },
        },
      }),
      this.prisma.cashSession.findFirst({
        where: { status: CashSessionStatus.OPEN },
        orderBy: { openedAt: 'desc' },
        select: { id: true },
      }),
      this.prisma.notification.count({
        where: { kind: 'PAYMENT_OVERDUE', sentAt: { not: null } },
      }),
      this.computeServiceBreakdown(monthStart, monthEnd),
    ]);

    let monthlyRevenueCents = 0;
    let tuitionPaidMonthCents = 0;
    let monthlyInvoicesPaidMonthCents = 0;
    let prevMonthlyRevenueCents = 0;
    let unpaidTotalCents = 0;
    let paymentsReceived = 0;
    let paymentsExpected = 0;
    let overdueOver30Days = 0;

    const statusCounts = { paid: 0, pending: 0, unpaid: 0 };
    const thirtyDaysAgo = new Date(now);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const rows: TxRow[] = [];

    const considerStatus = (s: PaymentStatus) => {
      paymentsExpected += 1;
      if (s === PaymentStatus.PAID) {
        paymentsReceived += 1;
        statusCounts.paid += 1;
      } else if (s === PaymentStatus.PENDING) {
        statusCounts.pending += 1;
      } else {
        statusCounts.unpaid += 1;
      }
    };

    const isOverdue = (s: PaymentStatus, sortDate: Date, yearM?: number, monthM?: number) => {
      if (s !== PaymentStatus.PENDING) return false;
      if (yearM != null && monthM != null) {
        const due = new Date(yearM, monthM - 1, 1);
        return due.getTime() < thirtyDaysAgo.getTime();
      }
      return sortDate.getTime() < thirtyDaysAgo.getTime();
    };

    for (const t of tuitionAll) {
      considerStatus(t.status);
      if (t.status === PaymentStatus.PENDING) {
        unpaidTotalCents += t.amountCents;
        if (isOverdue(t.status, t.updatedAt)) overdueOver30Days += 1;
      }
      if (t.status === PaymentStatus.PAID && paidInCalendarMonth(t.paidAt, t.updatedAt, monthStart, monthEnd)) {
        monthlyRevenueCents += t.amountCents;
        tuitionPaidMonthCents += t.amountCents;
      }
      if (t.status === PaymentStatus.PAID && paidInCalendarMonth(t.paidAt, t.updatedAt, prevStart, prevEnd)) {
        prevMonthlyRevenueCents += t.amountCents;
      }

      const c = t.enrollment.child;
      const studentName = `${c.firstName} ${c.lastName}`.trim();
      rows.push({
        id: `tuition:${t.id}`,
        date: (t.paidAt ?? t.updatedAt).toISOString(),
        studentName,
        className: t.enrollment.class?.name ?? t.enrollment.level.name,
        services: ['Scolarité'],
        amountCents: t.amountCents,
        paymentMethod: formatPaymentModeFromTransactionRef(t.transactionRef),
        status: t.status,
        statusLabel: statusLabelFr(t.status),
        sortDate: t.paidAt ?? t.updatedAt,
      });
    }

    for (const m of monthlyAll) {
      considerStatus(m.status);
      if (m.status === PaymentStatus.PENDING) {
        unpaidTotalCents += m.totalAmountCents;
        if (isOverdue(m.status, m.updatedAt, m.year, m.month)) overdueOver30Days += 1;
      }
      if (m.status === PaymentStatus.PAID && paidInCalendarMonth(m.paidAt, m.updatedAt, monthStart, monthEnd)) {
        monthlyRevenueCents += m.totalAmountCents;
        monthlyInvoicesPaidMonthCents += m.totalAmountCents;
      }
      if (m.status === PaymentStatus.PAID && paidInCalendarMonth(m.paidAt, m.updatedAt, prevStart, prevEnd)) {
        prevMonthlyRevenueCents += m.totalAmountCents;
      }

      const c = m.enrollment.child;
      const services = m.lines.map((l) =>
        l.kind === MonthlyBillingLineKind.MONTHLY_BASE
          ? 'Mensualité'
          : (l.serviceTariff?.label ?? l.label),
      );
      rows.push({
        id: `monthly:${m.id}`,
        date: (m.paidAt ?? m.updatedAt).toISOString(),
        studentName: `${c.firstName} ${c.lastName}`.trim(),
        className: m.enrollment.class?.name ?? m.enrollment.level.name,
        services: services.length ? services : ['Mensualité'],
        amountCents: m.totalAmountCents,
        paymentMethod: formatPaymentModeFromTransactionRef(m.transactionRef),
        status: m.status,
        statusLabel: statusLabelFr(m.status),
        sortDate: m.paidAt ?? m.updatedAt,
      });
    }

    for (const l of legacyAll) {
      considerStatus(l.status);
      if (l.status === PaymentStatus.PENDING) {
        unpaidTotalCents += l.amountCents;
        if (isOverdue(l.status, l.updatedAt, l.year, l.month)) overdueOver30Days += 1;
      }
      const isTuition = isLegacyTuitionRef(l.transactionRef);
      if (l.status === PaymentStatus.PAID && paidInCalendarMonth(l.paidAt, l.updatedAt, monthStart, monthEnd)) {
        monthlyRevenueCents += l.amountCents;
        if (isTuition) tuitionPaidMonthCents += l.amountCents;
        else monthlyInvoicesPaidMonthCents += l.amountCents;
      }
      if (l.status === PaymentStatus.PAID && paidInCalendarMonth(l.paidAt, l.updatedAt, prevStart, prevEnd)) {
        prevMonthlyRevenueCents += l.amountCents;
      }

      const c = l.enrollment.child;
      rows.push({
        id: `legacy:${l.id}`,
        date: (l.paidAt ?? l.updatedAt).toISOString(),
        studentName: `${c.firstName} ${c.lastName}`.trim(),
        className: l.enrollment.class?.name ?? l.enrollment.level.name,
        services: [isTuition ? 'Scolarité' : 'Mensualité'],
        amountCents: l.amountCents,
        paymentMethod: formatPaymentModeFromTransactionRef(l.transactionRef),
        status: l.status,
        statusLabel: statusLabelFr(l.status),
        sortDate: l.paidAt ?? l.updatedAt,
      });
    }

    let monthlyRevenueTrendPct: number | null = null;
    if (prevMonthlyRevenueCents > 0) {
      monthlyRevenueTrendPct = Math.round(
        ((monthlyRevenueCents - prevMonthlyRevenueCents) / prevMonthlyRevenueCents) * 100,
      );
    }

    const { serviceBreakdown, serviceBreakdownTotalCents, serviceBreakdownDetail } =
      serviceBreakdownData;

    const paidPercent =
      paymentsExpected > 0 ? Math.round((statusCounts.paid / paymentsExpected) * 100) : 0;

    let allTimeEntriesCents = 0;
    let allTimeTuitionCents = 0;
    let allTimeMonthlyCents = 0;
    for (const t of tuitionAll) {
      if (t.status === PaymentStatus.PAID) {
        allTimeEntriesCents += t.amountCents;
        allTimeTuitionCents += t.amountCents;
      }
    }
    for (const m of monthlyAll) {
      if (m.status === PaymentStatus.PAID) {
        allTimeEntriesCents += m.totalAmountCents;
        allTimeMonthlyCents += m.totalAmountCents;
      }
    }
    for (const l of legacyAll) {
      if (l.status === PaymentStatus.PAID) {
        allTimeEntriesCents += l.amountCents;
        if (isLegacyTuitionRef(l.transactionRef)) allTimeTuitionCents += l.amountCents;
        else allTimeMonthlyCents += l.amountCents;
      }
    }

    const [manualEntriesAgg, allExitsAgg] = await Promise.all([
      this.prisma.cashManualEntry.aggregate({ _sum: { amountCents: true } }),
      this.prisma.cashExpense.aggregate({ _sum: { amountCents: true } }),
    ]);
    const allTimeManualCents = manualEntriesAgg._sum.amountCents ?? 0;
    allTimeEntriesCents += allTimeManualCents;

    const allTimeExitsCents = allExitsAgg._sum.amountCents ?? 0;
    const allTimeBalanceCents = allTimeEntriesCents - allTimeExitsCents;

    const latestEncashment = this.resolveLatestEncashmentMonth([
      ...tuitionAll.filter((t) => t.status === PaymentStatus.PAID).map((t) => t.paidAt ?? t.updatedAt),
      ...monthlyAll.filter((m) => m.status === PaymentStatus.PAID).map((m) => m.paidAt ?? m.updatedAt),
      ...legacyAll.filter((l) => l.status === PaymentStatus.PAID).map((l) => l.paidAt ?? l.updatedAt),
    ]);

    let filtered = rows;
    if (search) {
      filtered = filtered.filter((r) => {
        const hay = `${r.studentName} ${r.className} ${r.services.join(' ')}`.toLowerCase();
        return hay.includes(search);
      });
    }
    if (serviceFilter && serviceFilter !== 'all') {
      const sf = serviceFilter.toLowerCase();
      filtered = filtered.filter((r) =>
        r.services.some((s) => s.toLowerCase().includes(sf)),
      );
    }

    filtered.sort((a, b) => b.sortDate.getTime() - a.sortDate.getTime());
    const total = filtered.length;
    const slice = filtered.slice((page - 1) * limit, (page - 1) * limit + limit);

    return {
      period: { monthLabel, year, month },
      kpis: {
        monthlyRevenueCents,
        monthlyRevenueTrendPct,
        unpaidTotalCents,
        paymentsReceived,
        paymentsExpected,
        overdueOver30Days,
        remindersSent: reminderCount,
      },
      /** Totaux cumulés (toutes périodes) : plateforme + caisse manuelle − sorties. */
      accountingTotals: {
        entriesCents: allTimeEntriesCents,
        exitsCents: allTimeExitsCents,
        balanceCents: allTimeBalanceCents,
        tuitionMonthCents: allTimeTuitionCents,
        monthlyInvoicesMonthCents: allTimeMonthlyCents,
        manualEntriesCents: allTimeManualCents,
        scope: 'all' as const,
      },
      /** Dernier mois calendaire avec au moins un paiement plateforme validé (date d’encaissement). */
      latestEncashment,
      cashSession: {
        sessionOpen: Boolean(openSession),
      },
      serviceBreakdown,
      serviceBreakdownTotalCents,
      serviceBreakdownDetail,
      paymentStatus: {
        ...statusCounts,
        paidPercent,
      },
      transactions: slice.map((r) => ({
        id: r.id,
        date: r.date,
        studentName: r.studentName,
        className: r.className,
        services: r.services,
        amountCents: r.amountCents,
        paymentMethod: r.paymentMethod,
        status: r.status,
        statusLabel: r.statusLabel,
      })),
      serviceOptions: ['all', ...serviceBreakdown.map((s) => s.label)],
      total,
      page,
      limit,
    };
  }

  /**
   * Répartition des encaissements du mois : lignes de mensualité (mensualité + options)
   * + scolarité annuelle + anciens paiements sans détail.
   */
  private async computeServiceBreakdown(monthStart: Date, monthEnd: Date) {
    const serviceMap = new Map<string, number>();
    const bump = (label: string, cents: number) => {
      if (cents <= 0) return;
      serviceMap.set(label, (serviceMap.get(label) ?? 0) + cents);
    };

    const paidLines = await this.prisma.monthlyInstallmentLine.findMany({
      where: {
        installment: paidInMonthFilter(monthStart, monthEnd),
      },
      include: { serviceTariff: true },
    });

    let optionLineCount = 0;
    for (const line of paidLines) {
      if (line.kind === MonthlyBillingLineKind.SERVICE) optionLineCount += 1;
      const label =
        line.kind === MonthlyBillingLineKind.MONTHLY_BASE
          ? 'Mensualité'
          : (line.serviceTariff?.label ?? line.label);
      bump(label, line.amountCents);
    }

    const tuitionAgg = await this.prisma.tuitionCharge.aggregate({
      where: paidInMonthFilter(monthStart, monthEnd),
      _sum: { amountCents: true },
    });
    bump('Scolarité', tuitionAgg._sum.amountCents ?? 0);

    const legacyPaid = await this.prisma.monthlyPayment.findMany({
      where: paidInMonthFilter(monthStart, monthEnd),
      select: { amountCents: true, transactionRef: true },
    });
    for (const l of legacyPaid) {
      bump(isLegacyTuitionRef(l.transactionRef) ? 'Scolarité' : 'Mensualité', l.amountCents);
    }

    const serviceBreakdown = [...serviceMap.entries()]
      .map(([label, amountCents]) => ({ label, amountCents }))
      .sort((a, b) => b.amountCents - a.amountCents);

    const serviceBreakdownTotalCents = serviceBreakdown.reduce((s, x) => s + x.amountCents, 0);

    let serviceBreakdownDetail: 'empty' | 'options' | 'basic';
    if (serviceBreakdownTotalCents === 0) {
      serviceBreakdownDetail = 'empty';
    } else if (optionLineCount > 0) {
      serviceBreakdownDetail = 'options';
    } else {
      serviceBreakdownDetail = 'basic';
    }

    return { serviceBreakdown, serviceBreakdownTotalCents, serviceBreakdownDetail };
  }

  /** Mois du dernier encaissement (paidAt ou updatedAt si paidAt absent). */
  private resolveLatestEncashmentMonth(dates: Date[]) {
    if (!dates.length) return null;
    let latest = dates[0]!.getTime();
    for (const d of dates) {
      const t = d.getTime();
      if (t > latest) latest = t;
    }
    const ref = new Date(latest);
    const y = ref.getFullYear();
    const m = ref.getMonth() + 1;
    const monthStart = new Date(y, m - 1, 1);
    const monthLabel = new Intl.DateTimeFormat('fr-FR', {
      month: 'long',
      year: 'numeric',
    }).format(monthStart);
    return { year: y, month: m, monthLabel };
  }

  /** Solde cumulé (toutes périodes) : paiements plateforme + entrées manuelles − toutes sorties. */
  private async computeAllTimeCashStats() {
    const paymentEntriesCents = await this.sumPaidAll();
    const [manualAgg, exitsAgg] = await Promise.all([
      this.prisma.cashManualEntry.aggregate({ _sum: { amountCents: true } }),
      this.prisma.cashExpense.aggregate({ _sum: { amountCents: true } }),
    ]);
    const manualCents = manualAgg._sum.amountCents ?? 0;
    const entriesCents = paymentEntriesCents + manualCents;
    const exitsCents = exitsAgg._sum.amountCents ?? 0;
    return {
      balanceCents: entriesCents - exitsCents,
      entriesCents,
      exitsCents,
      paymentsCents: paymentEntriesCents,
      manualCents,
      scope: 'all' as const,
    };
  }

  private async sumPaidAll(): Promise<number> {
    const where = { status: PaymentStatus.PAID };
    const [tuition, monthly, legacy] = await Promise.all([
      this.prisma.tuitionCharge.aggregate({ where, _sum: { amountCents: true } }),
      this.prisma.monthlyInstallment.aggregate({ where, _sum: { totalAmountCents: true } }),
      this.prisma.monthlyPayment.aggregate({ where, _sum: { amountCents: true } }),
    ]);
    return (
      (tuition._sum.amountCents ?? 0) +
      (monthly._sum.totalAmountCents ?? 0) +
      (legacy._sum.amountCents ?? 0)
    );
  }

  private async sumPaidSince(since: Date): Promise<number> {
    const where = paidSinceFilter(since);
    const [tuition, monthly, legacy] = await Promise.all([
      this.prisma.tuitionCharge.aggregate({
        where,
        _sum: { amountCents: true },
      }),
      this.prisma.monthlyInstallment.aggregate({
        where,
        _sum: { totalAmountCents: true },
      }),
      this.prisma.monthlyPayment.aggregate({
        where,
        _sum: { amountCents: true },
      }),
    ]);
    return (
      (tuition._sum.amountCents ?? 0) +
      (monthly._sum.totalAmountCents ?? 0) +
      (legacy._sum.amountCents ?? 0)
    );
  }

  async openCashSession(openedById?: string) {
    const existing = await this.prisma.cashSession.findFirst({
      where: { status: CashSessionStatus.OPEN },
    });
    if (existing) return existing;
    return this.prisma.cashSession.create({
      data: {
        status: CashSessionStatus.OPEN,
        openedById: openedById || undefined,
      },
    });
  }

  async closeCashSession() {
    const session = await this.prisma.cashSession.findFirst({
      where: { status: CashSessionStatus.OPEN },
      orderBy: { openedAt: 'desc' },
    });
    if (!session) throw new NotFoundException('Aucune caisse ouverte.');
    return this.prisma.cashSession.update({
      where: { id: session.id },
      data: { status: CashSessionStatus.CLOSED, closedAt: new Date() },
    });
  }

  async getCashDesk(query: { page?: number; limit?: number; search?: string }) {
    const session = await this.prisma.cashSession.findFirst({
      where: { status: CashSessionStatus.OPEN },
      orderBy: { openedAt: 'desc' },
      include: { expenses: true, manualEntries: true },
    });

    if (!session) {
      return { sessionOpen: false as const };
    }

    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 10));
    const search = query.search?.trim().toLowerCase();
    const since = session.openedAt;

    type CashEntryRow = {
      id: string;
      date: string;
      description: string;
      source: string;
      amountCents: number;
      paymentMethod: string;
      hasInvoice: boolean;
      invoiceNumber: string | null;
      sortDate: Date;
    };

    const rows: CashEntryRow[] = [];

    const enrollmentSource = (child: { firstName: string; lastName: string; parent: { fullName: string | null; email: string } | null }) => {
      const parent = child.parent?.fullName?.trim() || child.parent?.email?.trim();
      if (parent) return parent;
      return `${child.firstName} ${child.lastName}`.trim();
    };

    const paidWhere = paidSinceFilter(since);
    const [tuitionPaid, monthlyPaid, legacyPaid] = await Promise.all([
      this.prisma.tuitionCharge.findMany({
        where: paidWhere,
        select: {
          id: true,
          amountCents: true,
          paidAt: true,
          updatedAt: true,
          transactionRef: true,
          enrollment: { include: { child: { include: { parent: { select: { fullName: true, email: true } } } } } },
        },
      }),
      this.prisma.monthlyInstallment.findMany({
        where: paidWhere,
        include: {
          lines: { include: { serviceTariff: true } },
          enrollment: { include: { child: { include: { parent: { select: { fullName: true, email: true } } } } } },
        },
      }),
      this.prisma.monthlyPayment.findMany({
        where: paidWhere,
        select: {
          id: true,
          amountCents: true,
          paidAt: true,
          updatedAt: true,
          transactionRef: true,
          enrollment: { include: { child: { include: { parent: { select: { fullName: true, email: true } } } } } },
        },
      }),
    ]);

    for (const t of tuitionPaid) {
      const paid = effectivePaidAt(t.paidAt, t.updatedAt);
      rows.push({
        id: `tuition:${t.id}`,
        date: paid.toISOString(),
        description: 'Paiement scolarité',
        source: enrollmentSource(t.enrollment.child),
        amountCents: t.amountCents,
        paymentMethod: formatPaymentModeFromTransactionRef(t.transactionRef),
        hasInvoice: true,
        invoiceNumber: null,
        sortDate: paid,
      });
    }

    for (const m of monthlyPaid) {
      const paid = effectivePaidAt(m.paidAt, m.updatedAt);
      for (const line of m.lines) {
        const label =
          line.kind === MonthlyBillingLineKind.MONTHLY_BASE
            ? 'Mensualité'
            : (line.serviceTariff?.label ?? line.label);
        rows.push({
          id: `monthly:${m.id}:${line.id}`,
          date: paid.toISOString(),
          description: `Paiement ${label}`,
          source: enrollmentSource(m.enrollment.child),
          amountCents: line.amountCents,
          paymentMethod: formatPaymentModeFromTransactionRef(m.transactionRef),
          hasInvoice: true,
          invoiceNumber: null,
          sortDate: paid,
        });
      }
    }

    for (const l of legacyPaid) {
      const paid = effectivePaidAt(l.paidAt, l.updatedAt);
      const isTuition = isLegacyTuitionRef(l.transactionRef);
      rows.push({
        id: `legacy:${l.id}`,
        date: paid.toISOString(),
        description: isTuition ? 'Paiement scolarité' : 'Paiement mensualité',
        source: enrollmentSource(l.enrollment.child),
        amountCents: l.amountCents,
        paymentMethod: formatPaymentModeFromTransactionRef(l.transactionRef),
        hasInvoice: true,
        invoiceNumber: null,
        sortDate: paid,
      });
    }

    for (const e of session.manualEntries) {
      const entryAt = e.entryAt ?? e.createdAt;
      rows.push({
        id: `manual:${e.id}`,
        date: entryAt.toISOString(),
        description: e.description,
        source: e.source?.trim() || 'Caisse — manuelle',
        amountCents: e.amountCents,
        paymentMethod: e.paymentMethod?.trim() || 'Espèces',
        hasInvoice: e.hasInvoice,
        invoiceNumber: e.invoiceNumber?.trim() || null,
        sortDate: entryAt,
      });
    }

    const cashStats = await this.computeAllTimeCashStats();

    let filtered = rows;
    if (search) {
      filtered = filtered.filter((r) => {
        const hay = `${r.description} ${r.source} ${r.paymentMethod}`.toLowerCase();
        return hay.includes(search);
      });
    }
    filtered.sort((a, b) => b.sortDate.getTime() - a.sortDate.getTime());

    const total = filtered.length;
    const slice = filtered.slice((page - 1) * limit, (page - 1) * limit + limit);

    return {
      sessionOpen: true as const,
      sessionId: session.id,
      openedAt: session.openedAt.toISOString(),
      stats: cashStats,
      entries: slice.map(({ sortDate: _s, ...rest }) => rest),
      total,
      page,
      limit,
    };
  }

  private async requireOpenCashSession() {
    const session = await this.prisma.cashSession.findFirst({
      where: { status: CashSessionStatus.OPEN },
      orderBy: { openedAt: 'desc' },
    });
    if (!session) {
      throw new BadRequestException('Ouvrez la caisse avant cette opération.');
    }
    return session;
  }

  private async enrollmentHasPendingTuition(enrollmentId: string): Promise<boolean> {
    const n = await this.prisma.tuitionCharge.count({
      where: {
        enrollmentId,
        status: PaymentStatus.PENDING,
        amountCents: { gt: 0 },
      },
    });
    return n > 0;
  }

  /** Factures scolarité / mensualités impayées (inscriptions validées). */
  async getCashUnpaidBills(query: { search?: string; page?: number; limit?: number }) {
    await this.requireOpenCashSession();

    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));
    const search = query.search?.trim().toLowerCase();

    const enrollmentWhere = { status: EnrollmentStatus.APPROVED };

    const [tuitionRows, monthlyRows, legacyRows] = await Promise.all([
      this.prisma.tuitionCharge.findMany({
        where: {
          status: PaymentStatus.PENDING,
          amountCents: { gt: 0 },
          enrollment: enrollmentWhere,
        },
        include: {
          enrollment: { include: { child: true, level: true, class: true } },
        },
        orderBy: [{ schoolYear: 'desc' }, { updatedAt: 'desc' }],
      }),
      this.prisma.monthlyInstallment.findMany({
        where: {
          status: PaymentStatus.PENDING,
          totalAmountCents: { gt: 0 },
          enrollment: enrollmentWhere,
        },
        include: {
          lines: { include: { serviceTariff: true } },
          enrollment: { include: { child: true, level: true, class: true } },
        },
        orderBy: [{ year: 'asc' }, { month: 'asc' }],
      }),
      this.prisma.monthlyPayment.findMany({
        where: {
          status: PaymentStatus.PENDING,
          amountCents: { gt: 0 },
          enrollment: enrollmentWhere,
        },
        include: {
          enrollment: { include: { child: true, level: true, class: true } },
        },
        orderBy: [{ year: 'asc' }, { month: 'asc' }],
      }),
    ]);

    type BillRow = {
      id: string;
      kind: UnpaidBillKind;
      studentName: string;
      className: string;
      label: string;
      detail: string;
      amountCents: number;
      schoolYear: string;
      sortKey: string;
    };

    const bills: BillRow[] = [];
    const enrollmentsWithMonthlies = new Set(monthlyRows.map((m) => m.enrollmentId));

    for (const t of tuitionRows) {
      const c = t.enrollment.child;
      const studentName = `${c.firstName} ${c.lastName}`.trim();
      bills.push({
        id: `tuition:${t.id}`,
        kind: 'tuition',
        studentName,
        className: t.enrollment.class?.name ?? t.enrollment.level.name,
        label: enrollmentsWithMonthlies.has(t.enrollmentId) ? 'Scolarité' : 'Facture annuelle',
        detail: `Année ${t.schoolYear}`,
        amountCents: t.amountCents,
        schoolYear: t.schoolYear,
        sortKey: `0-${t.schoolYear}-${studentName}`,
      });
    }

    for (const m of monthlyRows) {
      const c = m.enrollment.child;
      const studentName = `${c.firstName} ${c.lastName}`.trim();
      const lineLabels = m.lines.map((l) =>
        l.kind === MonthlyBillingLineKind.MONTHLY_BASE
          ? 'Mensualité'
          : (l.serviceTariff?.label ?? l.label),
      );
      bills.push({
        id: `monthly:${m.id}`,
        kind: 'monthly',
        studentName,
        className: m.enrollment.class?.name ?? m.enrollment.level.name,
        label: 'Mensualité',
        detail: `${monthLabelFr(m.month)} ${m.year}${lineLabels.length ? ` — ${lineLabels.join(', ')}` : ''}`,
        amountCents: m.totalAmountCents,
        schoolYear: m.enrollment.schoolYear,
        sortKey: `1-${m.year}-${String(m.month).padStart(2, '0')}-${studentName}`,
      });
    }

    for (const l of legacyRows) {
      const c = l.enrollment.child;
      const studentName = `${c.firstName} ${c.lastName}`.trim();
      const isTuition = isLegacyTuitionRef(l.transactionRef);
      bills.push({
        id: `legacy:${l.id}`,
        kind: 'legacy',
        studentName,
        className: l.enrollment.class?.name ?? l.enrollment.level.name,
        label: isTuition ? 'Scolarité (ancien modèle)' : 'Mensualité (ancien modèle)',
        detail: `${monthLabelFr(l.month)} ${l.year}`,
        amountCents: l.amountCents,
        schoolYear: l.enrollment.schoolYear,
        sortKey: `2-${l.year}-${String(l.month).padStart(2, '0')}-${studentName}`,
      });
    }

    let filtered = bills;
    if (search) {
      filtered = filtered.filter((b) => {
        const hay = `${b.studentName} ${b.className} ${b.label} ${b.detail} ${b.schoolYear}`.toLowerCase();
        return hay.includes(search);
      });
    }

    filtered.sort((a, b) => a.sortKey.localeCompare(b.sortKey, 'fr'));

    const total = filtered.length;
    const slice = filtered.slice((page - 1) * limit, (page - 1) * limit + limit);

    return {
      items: slice.map(({ sortKey: _s, ...rest }) => rest),
      total,
      page,
      limit,
    };
  }

  /** Recherche d’une facture par numéro complet ou partiel (ex. 56883 → INV-2026-56883). */
  async lookupCashInvoiceByNumber(invoiceNumberRaw: string) {
    await this.requireOpenCashSession();

    const needle = normalizeInvoiceSearchQuery(invoiceNumberRaw);
    if (!needle) {
      throw new BadRequestException('Saisissez un numéro de facture.');
    }

    const enrollmentWhere = { status: EnrollmentStatus.APPROVED };

    const [tuitionRows, monthlyRows, legacyRows] = await Promise.all([
      this.prisma.tuitionCharge.findMany({
        where: { enrollment: enrollmentWhere },
        include: {
          enrollment: { include: { child: true, level: true, class: true } },
        },
      }),
      this.prisma.monthlyInstallment.findMany({
        where: { enrollment: enrollmentWhere },
        include: {
          lines: { include: { serviceTariff: true } },
          enrollment: { include: { child: true, level: true, class: true } },
        },
      }),
      this.prisma.monthlyPayment.findMany({
        where: { enrollment: enrollmentWhere },
        include: {
          enrollment: { include: { child: true, level: true, class: true } },
        },
      }),
    ]);

    type Match = {
      billId: string;
      invoiceNumber: string;
      studentName: string;
      className: string;
      label: string;
      detail: string;
      amountCents: number;
      schoolYear: string;
      status: PaymentStatus;
      statusLabel: string;
      canPay: boolean;
    };

    let exactMatch: Match | null = null;
    const partialMatches: Match[] = [];
    const enrollmentsWithMonthlies = new Set(monthlyRows.map((m) => m.enrollmentId));

    const consider = (inv: string, candidate: Match) => {
      if (inv === needle) {
        exactMatch = candidate;
        return;
      }
      if (invoiceNumberMatchesSearch(inv, needle)) {
        partialMatches.push(candidate);
      }
    };

    for (const t of tuitionRows) {
      const y = Number(t.schoolYear.trim().match(/^(\d{4})/)?.[1] ?? new Date().getFullYear());
      const inv = stableInvoiceNumber(y, t.id).toUpperCase();
      const c = t.enrollment.child;
      consider(inv, {
        billId: `tuition:${t.id}`,
        invoiceNumber: inv,
        studentName: `${c.firstName} ${c.lastName}`.trim(),
        className: t.enrollment.class?.name ?? t.enrollment.level.name,
        label: enrollmentsWithMonthlies.has(t.enrollmentId) ? 'Scolarité' : 'Facture annuelle',
        detail: `Année ${t.schoolYear}`,
        amountCents: t.amountCents,
        schoolYear: t.schoolYear,
        status: t.status,
        statusLabel: statusLabelFr(t.status),
        canPay: t.status === PaymentStatus.PENDING && t.amountCents > 0,
      });
      if (exactMatch) break;
    }

    if (!exactMatch) {
      for (const m of monthlyRows) {
        const inv = stableInvoiceNumber(m.year, m.id).toUpperCase();
        const c = m.enrollment.child;
        const lineLabels = m.lines.map((l) =>
          l.kind === MonthlyBillingLineKind.MONTHLY_BASE
            ? 'Mensualité'
            : (l.serviceTariff?.label ?? l.label),
        );
        consider(inv, {
          billId: `monthly:${m.id}`,
          invoiceNumber: inv,
          studentName: `${c.firstName} ${c.lastName}`.trim(),
          className: m.enrollment.class?.name ?? m.enrollment.level.name,
          label: 'Mensualité',
          detail: `${monthLabelFr(m.month)} ${m.year}${lineLabels.length ? ` — ${lineLabels.join(', ')}` : ''}`,
          amountCents: m.totalAmountCents,
          schoolYear: m.enrollment.schoolYear,
          status: m.status,
          statusLabel: statusLabelFr(m.status),
          canPay: m.status === PaymentStatus.PENDING && m.totalAmountCents > 0,
        });
        if (exactMatch) break;
      }
    }

    if (!exactMatch) {
      for (const l of legacyRows) {
        const inv = stableInvoiceNumber(l.year, l.id).toUpperCase();
        const c = l.enrollment.child;
        const isTuition = isLegacyTuitionRef(l.transactionRef);
        consider(inv, {
          billId: `legacy:${l.id}`,
          invoiceNumber: inv,
          studentName: `${c.firstName} ${c.lastName}`.trim(),
          className: l.enrollment.class?.name ?? l.enrollment.level.name,
          label: isTuition ? 'Scolarité (ancien modèle)' : 'Mensualité (ancien modèle)',
          detail: `${monthLabelFr(l.month)} ${l.year}`,
          amountCents: l.amountCents,
          schoolYear: l.enrollment.schoolYear,
          status: l.status,
          statusLabel: statusLabelFr(l.status),
          canPay: l.status === PaymentStatus.PENDING && l.amountCents > 0,
        });
        if (exactMatch) break;
      }
    }

    let match: Match | null = exactMatch;
    if (!match) {
      if (partialMatches.length === 1) {
        match = partialMatches[0];
      } else if (partialMatches.length > 1) {
        throw new BadRequestException(
          'Plusieurs factures correspondent à ce numéro. Précisez l’année (ex. INV-2026-56883).',
        );
      }
    }

    if (!match) {
      throw new NotFoundException('Aucune facture trouvée pour ce numéro.');
    }

    if (match.canPay && match.billId.startsWith('monthly:')) {
      const installmentId = match.billId.slice('monthly:'.length);
      const row = monthlyRows.find((m) => m.id === installmentId);
      if (row && (await this.enrollmentHasPendingTuition(row.enrollmentId))) {
        match = {
          ...match,
          canPay: false,
          statusLabel: 'Scolarité annuelle impayée — réglez-la d’abord',
        };
      }
    }

    if (match.canPay && match.billId.startsWith('legacy:')) {
      const legacyId = match.billId.slice('legacy:'.length);
      const row = legacyRows.find((l) => l.id === legacyId);
      if (
        row &&
        !isLegacyTuitionRef(row.transactionRef) &&
        (await this.enrollmentHasPendingTuition(row.enrollmentId))
      ) {
        match = {
          ...match,
          canPay: false,
          statusLabel: 'Scolarité annuelle impayée — réglez-la d’abord',
        };
      }
    }

    return { invoice: match };
  }

  /** Encaissement caisse d’une scolarité ou mensualité impayée. */
  async payCashBill(input: { billId?: string; paymentMethod?: string; hasInvoice?: boolean }) {
    const session = await this.requireOpenCashSession();
    const { kind, id } = parseCashBillId(String(input?.billId ?? ''));
    const paymentMethod = String(input?.paymentMethod ?? 'Espèces').trim() || 'Espèces';
    const transactionRef = buildCashTransactionRef(paymentMethod, session.id);

    let payment: unknown;

    if (kind === 'tuition') {
      const charge = await this.prisma.tuitionCharge.findUnique({
        where: { id },
        include: { enrollment: { select: { id: true, status: true } } },
      });
      if (!charge) throw new NotFoundException('Facture de scolarité introuvable.');
      if (charge.enrollment.status !== EnrollmentStatus.APPROVED) {
        throw new BadRequestException('Inscription non validée.');
      }
      if (charge.status !== PaymentStatus.PENDING) {
        throw new BadRequestException('Cette scolarité n’est plus en attente de paiement.');
      }
      payment = await this.payments.recordPayment({
        kind: 'TUITION',
        enrollmentId: charge.enrollmentId,
        schoolYear: charge.schoolYear,
        amountCents: charge.amountCents,
        transactionRef,
      });
    } else if (kind === 'monthly') {
      const row = await this.prisma.monthlyInstallment.findUnique({
        where: { id },
        include: { enrollment: { select: { id: true, status: true } } },
      });
      if (!row) throw new NotFoundException('Mensualité introuvable.');
      if (row.enrollment.status !== EnrollmentStatus.APPROVED) {
        throw new BadRequestException('Inscription non validée.');
      }
      if (row.status !== PaymentStatus.PENDING) {
        throw new BadRequestException('Cette mensualité n’est plus en attente de paiement.');
      }
      if (await this.enrollmentHasPendingTuition(row.enrollmentId)) {
        throw new BadRequestException(
          'Réglez d’abord la scolarité annuelle pour cet élève avant la mensualité.',
        );
      }
      payment = await this.payments.recordPayment({
        kind: 'MONTHLY_INSTALLMENT',
        enrollmentId: row.enrollmentId,
        year: row.year,
        month: row.month,
        amountCents: row.totalAmountCents,
        transactionRef,
      });
    } else {
      const row = await this.prisma.monthlyPayment.findUnique({
        where: { id },
        include: { enrollment: { select: { id: true, status: true } } },
      });
      if (!row) throw new NotFoundException('Échéance introuvable.');
      if (row.enrollment.status !== EnrollmentStatus.APPROVED) {
        throw new BadRequestException('Inscription non validée.');
      }
      if (row.status !== PaymentStatus.PENDING) {
        throw new BadRequestException('Cette échéance n’est plus en attente de paiement.');
      }
      if (!isLegacyTuitionRef(row.transactionRef)) {
        if (await this.enrollmentHasPendingTuition(row.enrollmentId)) {
          throw new BadRequestException(
            'Réglez d’abord la scolarité annuelle pour cet élève avant la mensualité.',
          );
        }
      }
      payment = await this.payments.recordPayment({
        kind: 'LEGACY',
        enrollmentId: row.enrollmentId,
        year: row.year,
        month: row.month,
        amountCents: row.amountCents,
        transactionRef,
      });
    }

    const stats = await this.computeAllTimeCashStats();
    return { payment, stats, hasInvoice: Boolean(input?.hasInvoice) };
  }

  private parseManualEntryDate(raw: string | undefined): Date {
    const s = String(raw ?? '').trim();
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return new Date();
    const y = parseInt(m[1]!, 10);
    const mo = parseInt(m[2]!, 10) - 1;
    const d = parseInt(m[3]!, 10);
    const dt = new Date(y, mo, d, 12, 0, 0, 0);
    if (Number.isNaN(dt.getTime())) return new Date();
    return dt;
  }

  async addManualEntry(input: {
    description?: string;
    amountCents?: number;
    paymentMethod?: string;
    source?: string;
    invoiceNumber?: string;
    entryDate?: string;
    hasInvoice?: boolean;
  }) {
    const session = await this.prisma.cashSession.findFirst({
      where: { status: CashSessionStatus.OPEN },
      orderBy: { openedAt: 'desc' },
    });
    if (!session) throw new BadRequestException('Ouvrez la caisse avant d’enregistrer une entrée.');

    const description = String(input?.description ?? '').trim();
    const amountCents = Number(input?.amountCents);
    if (!description) throw new BadRequestException('description is required');
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      throw new BadRequestException('amountCents must be a positive integer');
    }

    const paymentMethod = String(input?.paymentMethod ?? 'Espèces').trim() || 'Espèces';
    const source = String(input?.source ?? 'Paiement').trim() || 'Paiement';
    const invoiceNumber = String(input?.invoiceNumber ?? '').trim() || null;
    const entryAt = this.parseManualEntryDate(input?.entryDate);
    const hasInvoice = Boolean(input?.hasInvoice) || Boolean(invoiceNumber);

    const entry = await this.prisma.cashManualEntry.create({
      data: {
        sessionId: session.id,
        description,
        amountCents,
        paymentMethod,
        source,
        invoiceNumber,
        entryAt,
        hasInvoice,
      },
    });

    const stats = await this.computeAllTimeCashStats();

    return { entry, stats };
  }

  async addCashExpense(input: {
    label?: string;
    amountCents?: number;
    paymentMethod?: string;
    expenseDate?: string;
    hasInvoice?: boolean;
  }) {
    const session = await this.prisma.cashSession.findFirst({
      where: { status: CashSessionStatus.OPEN },
      orderBy: { openedAt: 'desc' },
    });
    if (!session) throw new BadRequestException('Ouvrez la caisse avant d’enregistrer une sortie.');

    const label = String(input?.label ?? '').trim();
    const amountCents = Number(input?.amountCents);
    if (!label) throw new BadRequestException('label is required');
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      throw new BadRequestException('amountCents must be a positive integer');
    }

    const paymentMethod = String(input?.paymentMethod ?? 'Espèces').trim() || 'Espèces';
    const expenseAt = this.parseManualEntryDate(input?.expenseDate);

    const expense = await this.prisma.cashExpense.create({
      data: {
        sessionId: session.id,
        label,
        amountCents,
        paymentMethod,
        expenseAt,
        hasInvoice: Boolean(input?.hasInvoice),
      },
    });

    const stats = await this.computeAllTimeCashStats();

    return { expense, stats };
  }

  async exportCsv(query: { search?: string; service?: string }) {
    const data = await this.getOverview({
      page: 1,
      limit: 10000,
      search: query.search,
      service: query.service,
    });
    const header = [
      'Date',
      'Élève',
      'Classe',
      'Services',
      'Montant (XOF)',
      'Mode',
      'Statut',
    ];
    const lines = data.transactions.map((r) => {
      const date = new Date(r.date);
      const dateFr = Number.isNaN(date.getTime())
        ? r.date
        : new Intl.DateTimeFormat('fr-FR').format(date);
      const amount = (r.amountCents / 100).toFixed(0);
      const services = r.services.join(' · ');
      return [dateFr, r.studentName, r.className, services, amount, r.paymentMethod, r.statusLabel]
        .map((c) => `"${String(c).replace(/"/g, '""')}"`)
        .join(',');
    });
    return [header.join(','), ...lines].join('\n');
  }
}
