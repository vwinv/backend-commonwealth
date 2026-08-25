import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import {
  EnrollmentStatus,
  MonthlyBillingLineKind,
  PaymentStatus,
  Prisma,
  TuitionBillingLineKind,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { billingMonthsForSchoolYear } from './school-year';

export type BillingTx = Omit<
  Prisma.TransactionClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

type TuitionLineDraft = {
  kind: TuitionBillingLineKind;
  serviceTariffId: string | null;
  label: string;
  quantity: number;
  unitAmountCents: number;
  amountCents: number;
};

@Injectable()
export class BillingService implements OnModuleInit {
  private readonly logger = new Logger(BillingService.name);

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    try {
      await this.reconcileAnnualParentsPendingMonthlies();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn(`reconcileAnnualParentsPendingMonthlies: ${msg}`);
    }
  }

  /**
   * Parents sans échéancier : convertir les mensualités encore en attente
   * en une facture annuelle (scolarité + mensualité × mois de l’année).
   */
  async reconcileAnnualParentsPendingMonthlies() {
    const pending = await this.prisma.monthlyInstallment.findMany({
      where: {
        status: PaymentStatus.PENDING,
        enrollment: {
          status: EnrollmentStatus.APPROVED,
          child: { parent: { monthlyPaymentPlanEnabled: false } },
        },
      },
      select: { enrollmentId: true },
      distinct: ['enrollmentId'],
    });
    if (!pending.length) return { enrollmentsUpdated: 0 };
    for (const row of pending) {
      try {
        await this.syncEnrollmentBilling(row.enrollmentId);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.logger.warn(`syncEnrollmentBilling(${row.enrollmentId}): ${msg}`);
      }
    }
    return { enrollmentsUpdated: pending.length };
  }

  /**
   * Associe les codes services (inscription) aux tarifs existants (code insensible à la casse).
   */
  async attachServiceSubscriptionsFromCodes(
    tx: BillingTx,
    enrollmentId: string,
    codes: string[],
  ): Promise<void> {
    const normalized = [...new Set(codes.map((c) => String(c).trim().toUpperCase()).filter(Boolean))];
    if (normalized.length === 0) return;

    const tariffs = await tx.serviceTariff.findMany({
      where: { code: { in: normalized }, active: true },
    });
    await this.attachServiceSubscriptions(
      tx,
      enrollmentId,
      tariffs.map((t) => ({ serviceTariffId: t.id, code: t.code, variantId: null })),
    );
  }

  async attachServiceSubscriptions(
    tx: BillingTx,
    enrollmentId: string,
    selections: Array<{ serviceTariffId: string; code?: string; variantId?: string | null }>,
  ): Promise<void> {
    const unique = new Map<string, { serviceTariffId: string; variantId: string | null }>();
    for (const sel of selections) {
      const serviceTariffId = String(sel.serviceTariffId ?? '').trim();
      if (!serviceTariffId) continue;
      unique.set(serviceTariffId, {
        serviceTariffId,
        variantId:
          sel.variantId === undefined || sel.variantId === null || sel.variantId === ''
            ? null
            : String(sel.variantId).trim(),
      });
    }
    if (unique.size === 0) return;

    for (const sel of unique.values()) {
      await tx.enrollmentServiceSubscription.upsert({
        where: {
          enrollmentId_serviceTariffId: { enrollmentId, serviceTariffId: sel.serviceTariffId },
        },
        update: { variantId: sel.variantId },
        create: {
          enrollmentId,
          serviceTariffId: sel.serviceTariffId,
          variantId: sel.variantId,
        },
      });
    }
  }

  async replaceServiceSubscriptions(
    tx: BillingTx,
    enrollmentId: string,
    selections: Array<{ serviceTariffId: string; code?: string; variantId?: string | null }>,
  ): Promise<void> {
    await tx.enrollmentServiceSubscription.deleteMany({ where: { enrollmentId } });
    await this.attachServiceSubscriptions(tx, enrollmentId, selections);
  }

  /**
   * Après validation admin.
   * Défaut : une facture annuelle = scolarité + mensualité × mois (+ options).
   * Échéancier : facture de scolarité + factures mensuelles (mensualité + options).
   * Les lignes déjà payées ne sont jamais écrasées.
   */
  async setupAfterApproval(tx: BillingTx, enrollmentId: string): Promise<{
    tuitionCreated: boolean;
    monthsGenerated: number;
    warnings: string[];
  }> {
    const enrollment = await tx.enrollment.findUnique({
      where: { id: enrollmentId },
      select: {
        id: true,
        status: true,
        schoolYear: true,
        levelId: true,
        scheduleId: true,
        child: {
          select: {
            parent: { select: { monthlyPaymentPlanEnabled: true } },
          },
        },
      },
    });
    if (!enrollment || enrollment.status !== EnrollmentStatus.APPROVED) {
      return { tuitionCreated: false, monthsGenerated: 0, warnings: ['Inscription introuvable ou non approuvée'] };
    }

    const monthlyPlan = Boolean(enrollment.child.parent?.monthlyPaymentPlanEnabled);
    const warnings: string[] = [];
    const amounts = await this.resolveTuitionAmounts(tx, enrollment, warnings);
    if (!amounts) {
      return { tuitionCreated: false, monthsGenerated: 0, warnings };
    }
    const { annualTuitionCents, monthlyBaseCents } = amounts;

    const months = billingMonthsForSchoolYear(enrollment.schoolYear);
    if (months.length === 0) {
      warnings.push(`Format d’année scolaire invalide : « ${enrollment.schoolYear} » (attendu ex. 2025-2026).`);
    }

    const optionLines = await this.collectOptionLines(tx, enrollment, warnings);
    const optionsPerMonthCents = optionLines.reduce((s, l) => s + l.amountCents, 0);
    const monthCount = months.length;
    const yearlyMonthlyCents = monthlyBaseCents * monthCount;
    const optionsYearlyCents = optionsPerMonthCents * monthCount;

    if (monthlyPlan) {
      return this.setupMonthlyPlan(tx, {
        enrollmentId,
        schoolYear: enrollment.schoolYear,
        months,
        annualTuitionCents,
        monthlyBaseCents,
        yearlyMonthlyCents,
        optionsYearlyCents,
        optionLines,
        warnings,
      });
    }

    return this.setupAnnualPlan(tx, {
      enrollmentId,
      schoolYear: enrollment.schoolYear,
      months,
      annualTuitionCents,
      monthlyBaseCents,
      yearlyMonthlyCents,
      optionsYearlyCents,
      optionLines,
      warnings,
    });
  }

  private async resolveTuitionAmounts(
    tx: BillingTx,
    enrollment: { schoolYear: string; levelId: string; scheduleId: string | null },
    warnings: string[],
  ): Promise<{ annualTuitionCents: number; monthlyBaseCents: number } | null> {
    let annualTuitionCents = 0;
    let monthlyBaseCents = 0;

    if (enrollment.scheduleId) {
      const schedule = await tx.levelSchedule.findUnique({
        where: { id: enrollment.scheduleId },
        select: { annualTuitionCents: true, monthlyBaseCents: true, active: true },
      });
      if (schedule?.active) {
        annualTuitionCents = schedule.annualTuitionCents;
        monthlyBaseCents = schedule.monthlyBaseCents;
      }
    }

    if (!annualTuitionCents && !monthlyBaseCents) {
      const pricing = await tx.levelSchoolYearPricing.findUnique({
        where: {
          schoolYear_levelId: { schoolYear: enrollment.schoolYear, levelId: enrollment.levelId },
        },
      });

      if (!pricing) {
        warnings.push(
          `Aucun barème pour l’année « ${enrollment.schoolYear} » et ce niveau : la scolarité n’est pas générée.`,
        );
        return null;
      }
      annualTuitionCents = pricing.annualTuitionCents;
      monthlyBaseCents = pricing.monthlyBaseCents;
    }

    return { annualTuitionCents, monthlyBaseCents };
  }

  private async collectOptionLines(
    tx: BillingTx,
    enrollment: { id: string; schoolYear: string; levelId: string },
    warnings: string[],
  ): Promise<Array<{ serviceTariffId: string; label: string; amountCents: number }>> {
    const subs = await tx.enrollmentServiceSubscription.findMany({
      where: { enrollmentId: enrollment.id },
      include: { serviceTariff: true },
    });
    const lines: Array<{ serviceTariffId: string; label: string; amountCents: number }> = [];

    for (const sub of subs) {
      const sp = await tx.serviceLevelPrice.findFirst({
        where: {
          schoolYear: enrollment.schoolYear,
          levelId: enrollment.levelId,
          serviceTariffId: sub.serviceTariffId,
          variantId: sub.variantId ?? null,
        },
        include: { variant: true },
      });
      if (!sp) {
        warnings.push(
          `Pas de tarif pour l’option « ${sub.serviceTariff.label} » (${sub.serviceTariff.code}) sur ce niveau / année.`,
        );
        continue;
      }
      const optionLabel = sp.variant?.label
        ? `${sub.serviceTariff.label} — ${sp.variant.label}`
        : sub.serviceTariff.label;
      lines.push({
        serviceTariffId: sub.serviceTariffId,
        label: optionLabel,
        amountCents: sp.monthlyAmountCents,
      });
    }

    return lines;
  }

  /** Une facture = scolarité + mensualité × mois de l’année scolaire (+ options). */
  private async setupAnnualPlan(
    tx: BillingTx,
    params: {
      enrollmentId: string;
      schoolYear: string;
      months: Array<{ year: number; month: number }>;
      annualTuitionCents: number;
      monthlyBaseCents: number;
      yearlyMonthlyCents: number;
      optionsYearlyCents: number;
      optionLines: Array<{ serviceTariffId: string; label: string; amountCents: number }>;
      warnings: string[];
    },
  ): Promise<{ tuitionCreated: boolean; monthsGenerated: number; warnings: string[] }> {
    const {
      enrollmentId,
      schoolYear,
      months,
      annualTuitionCents,
      monthlyBaseCents,
      yearlyMonthlyCents,
      optionsYearlyCents,
      optionLines,
      warnings,
    } = params;

    const fullPackageCents = annualTuitionCents + yearlyMonthlyCents + optionsYearlyCents;
    const paidMonthlySum = await this.sumPaidMonthlies(tx, enrollmentId);
    const existingTuition = await tx.tuitionCharge.findUnique({
      where: { enrollmentId_schoolYear: { enrollmentId, schoolYear } },
    });

    if (existingTuition?.status === PaymentStatus.PAID) {
      const remainingCents = Math.max(0, fullPackageCents - existingTuition.amountCents - paidMonthlySum);
      if (remainingCents <= 0) {
        await tx.monthlyInstallment.deleteMany({
          where: { enrollmentId, status: PaymentStatus.PENDING },
        });
        return { tuitionCreated: false, monthsGenerated: 0, warnings: [...new Set(warnings)] };
      }
      warnings.push(
        'La scolarité est déjà réglée : le solde (mensualités / options) reste en factures mensuelles.',
      );
      const monthsGenerated = await this.syncMonthlyInstallments(tx, {
        enrollmentId,
        months,
        monthlyBaseCents,
        optionLines,
      });
      return { tuitionCreated: false, monthsGenerated, warnings: [...new Set(warnings)] };
    }

    await tx.monthlyInstallment.deleteMany({
      where: { enrollmentId, status: PaymentStatus.PENDING },
    });
    const lines = this.buildAnnualPackageLines({
      annualTuitionCents,
      monthlyBaseCents,
      monthCount: months.length,
      optionLines,
      paidMonthlySum,
    });
    const netCents = lines.reduce((s, l) => s + l.amountCents, 0);
    const tuitionCreated = await this.upsertPendingTuition(tx, {
      enrollmentId,
      schoolYear,
      amountCents: netCents,
      existing: existingTuition,
      lines,
    });
    return { tuitionCreated, monthsGenerated: 0, warnings: [...new Set(warnings)] };
  }

  /** Facture de scolarité + une facture par mois (mensualité + options). */
  private async setupMonthlyPlan(
    tx: BillingTx,
    params: {
      enrollmentId: string;
      schoolYear: string;
      months: Array<{ year: number; month: number }>;
      annualTuitionCents: number;
      monthlyBaseCents: number;
      yearlyMonthlyCents: number;
      optionsYearlyCents: number;
      optionLines: Array<{ serviceTariffId: string; label: string; amountCents: number }>;
      warnings: string[];
    },
  ): Promise<{ tuitionCreated: boolean; monthsGenerated: number; warnings: string[] }> {
    const {
      enrollmentId,
      schoolYear,
      months,
      annualTuitionCents,
      monthlyBaseCents,
      yearlyMonthlyCents,
      optionsYearlyCents,
      optionLines,
      warnings,
    } = params;

    const fullPackageCents = annualTuitionCents + yearlyMonthlyCents + optionsYearlyCents;
    const existingTuition = await tx.tuitionCharge.findUnique({
      where: { enrollmentId_schoolYear: { enrollmentId, schoolYear } },
    });

    const extrasAlreadyPaid =
      existingTuition?.status === PaymentStatus.PAID &&
      existingTuition.amountCents >= fullPackageCents;

    const tuitionCreated = extrasAlreadyPaid
      ? false
      : await this.upsertPendingTuition(tx, {
          enrollmentId,
          schoolYear,
          amountCents: annualTuitionCents,
          existing: existingTuition,
          lines: this.buildTuitionOnlyLines(annualTuitionCents),
        });

    if (extrasAlreadyPaid) {
      await tx.monthlyInstallment.deleteMany({
        where: { enrollmentId, status: PaymentStatus.PENDING },
      });
      return { tuitionCreated: false, monthsGenerated: 0, warnings: [...new Set(warnings)] };
    }

    const monthsGenerated = await this.syncMonthlyInstallments(tx, {
      enrollmentId,
      months,
      monthlyBaseCents,
      optionLines,
    });
    return { tuitionCreated, monthsGenerated, warnings: [...new Set(warnings)] };
  }

  private async sumPaidMonthlies(tx: BillingTx, enrollmentId: string): Promise<number> {
    const paidMonthly = await tx.monthlyInstallment.aggregate({
      where: { enrollmentId, status: PaymentStatus.PAID },
      _sum: { totalAmountCents: true },
    });
    return paidMonthly._sum.totalAmountCents ?? 0;
  }

  private buildTuitionOnlyLines(annualTuitionCents: number): TuitionLineDraft[] {
    if (annualTuitionCents <= 0) return [];
    return [
      {
        kind: TuitionBillingLineKind.TUITION,
        serviceTariffId: null,
        label: 'Frais de scolarité',
        quantity: 1,
        unitAmountCents: annualTuitionCents,
        amountCents: annualTuitionCents,
      },
    ];
  }

  private buildAnnualPackageLines(params: {
    annualTuitionCents: number;
    monthlyBaseCents: number;
    monthCount: number;
    optionLines: Array<{ serviceTariffId: string; label: string; amountCents: number }>;
    paidMonthlySum: number;
  }): TuitionLineDraft[] {
    const { annualTuitionCents, monthlyBaseCents, monthCount, optionLines, paidMonthlySum } = params;
    const lines: TuitionLineDraft[] = [];

    if (annualTuitionCents > 0) {
      lines.push({
        kind: TuitionBillingLineKind.TUITION,
        serviceTariffId: null,
        label: 'Frais de scolarité',
        quantity: 1,
        unitAmountCents: annualTuitionCents,
        amountCents: annualTuitionCents,
      });
    }
    if (monthlyBaseCents > 0 && monthCount > 0) {
      lines.push({
        kind: TuitionBillingLineKind.MONTHLY_BASE,
        serviceTariffId: null,
        label: `Mensualité (${monthCount} mois, septembre à juin)`,
        quantity: monthCount,
        unitAmountCents: monthlyBaseCents,
        amountCents: monthlyBaseCents * monthCount,
      });
    }
    for (const opt of optionLines) {
      if (opt.amountCents <= 0 || monthCount <= 0) continue;
      lines.push({
        kind: TuitionBillingLineKind.SERVICE,
        serviceTariffId: opt.serviceTariffId,
        label: `${opt.label} (${monthCount} mois)`,
        quantity: monthCount,
        unitAmountCents: opt.amountCents,
        amountCents: opt.amountCents * monthCount,
      });
    }

    const gross = lines.reduce((s, l) => s + l.amountCents, 0);
    const credit = Math.min(Math.max(0, paidMonthlySum), gross);
    if (credit > 0) {
      lines.push({
        kind: TuitionBillingLineKind.CREDIT,
        serviceTariffId: null,
        label: 'Avoir — mensualités déjà réglées',
        quantity: 1,
        unitAmountCents: -credit,
        amountCents: -credit,
      });
    }
    return lines;
  }

  private async upsertPendingTuition(
    tx: BillingTx,
    params: {
      enrollmentId: string;
      schoolYear: string;
      amountCents: number;
      existing: { id: string; status: PaymentStatus } | null;
      lines: TuitionLineDraft[];
    },
  ): Promise<boolean> {
    const { enrollmentId, schoolYear, amountCents, existing, lines } = params;
    if (existing?.status === PaymentStatus.PAID) return false;

    if (amountCents <= 0) {
      if (existing?.status === PaymentStatus.PENDING) {
        await tx.tuitionCharge.delete({ where: { id: existing.id } });
      }
      return false;
    }

    const lineCreates = lines.map((l, i) => ({
      kind: l.kind,
      serviceTariffId: l.serviceTariffId,
      label: l.label,
      quantity: l.quantity,
      unitAmountCents: l.unitAmountCents,
      amountCents: l.amountCents,
      sortOrder: i,
    }));

    if (!existing) {
      await tx.tuitionCharge.create({
        data: {
          enrollmentId,
          schoolYear,
          amountCents,
          status: PaymentStatus.PENDING,
          lines: { create: lineCreates },
        },
      });
      return true;
    }

    await tx.tuitionChargeLine.deleteMany({ where: { chargeId: existing.id } });
    await tx.tuitionCharge.update({
      where: { id: existing.id },
      data: {
        amountCents,
        lines: { create: lineCreates },
      },
    });
    return true;
  }

  private async syncMonthlyInstallments(
    tx: BillingTx,
    params: {
      enrollmentId: string;
      months: Array<{ year: number; month: number }>;
      monthlyBaseCents: number;
      optionLines: Array<{ serviceTariffId: string; label: string; amountCents: number }>;
    },
  ): Promise<number> {
    const { enrollmentId, months, monthlyBaseCents, optionLines } = params;
    let monthsGenerated = 0;

    for (const { year, month } of months) {
      const lines: {
        kind: MonthlyBillingLineKind;
        serviceTariffId: string | null;
        label: string;
        amountCents: number;
      }[] = [];

      if (monthlyBaseCents > 0) {
        lines.push({
          kind: MonthlyBillingLineKind.MONTHLY_BASE,
          serviceTariffId: null,
          label: 'Mensualité',
          amountCents: monthlyBaseCents,
        });
      }
      for (const opt of optionLines) {
        lines.push({
          kind: MonthlyBillingLineKind.SERVICE,
          serviceTariffId: opt.serviceTariffId,
          label: opt.label,
          amountCents: opt.amountCents,
        });
      }

      const totalAmountCents = lines.reduce((s, l) => s + l.amountCents, 0);
      const existing = await tx.monthlyInstallment.findUnique({
        where: { enrollmentId_year_month: { enrollmentId, year, month } },
        select: { id: true, status: true },
      });

      if (existing?.status === PaymentStatus.PAID) continue;

      if (totalAmountCents <= 0) {
        if (existing) await tx.monthlyInstallment.delete({ where: { id: existing.id } });
        continue;
      }

      if (existing) {
        await tx.monthlyInstallmentLine.deleteMany({ where: { installmentId: existing.id } });
        await tx.monthlyInstallment.update({
          where: { id: existing.id },
          data: {
            totalAmountCents,
            lines: {
              create: lines.map((l) => ({
                kind: l.kind,
                serviceTariffId: l.serviceTariffId,
                label: l.label,
                amountCents: l.amountCents,
              })),
            },
          },
        });
      } else {
        await tx.monthlyInstallment.create({
          data: {
            enrollmentId,
            year,
            month,
            totalAmountCents,
            status: PaymentStatus.PENDING,
            lines: {
              create: lines.map((l) => ({
                kind: l.kind,
                serviceTariffId: l.serviceTariffId,
                label: l.label,
                amountCents: l.amountCents,
              })),
            },
          },
        });
      }
      monthsGenerated += 1;
    }

    return monthsGenerated;
  }

  /** Recalcule la facturation de toutes les inscriptions validées d’un parent. */
  async syncApprovedBillingForParent(parentId: string) {
    const enrollments = await this.prisma.enrollment.findMany({
      where: { status: EnrollmentStatus.APPROVED, child: { parentId } },
      select: { id: true },
    });
    const results: Array<{ tuitionCreated: boolean; monthsGenerated: number; warnings: string[] }> = [];
    for (const row of enrollments) {
      results.push(await this.syncEnrollmentBilling(row.id));
    }
    return { enrollmentsUpdated: enrollments.length, results };
  }

  /** Recalcul hors transaction (admin / maintenance). */
  async syncEnrollmentBilling(enrollmentId: string) {
    const enrollment = await this.prisma.enrollment.findUnique({
      where: { id: enrollmentId },
      select: { status: true },
    });
    if (!enrollment) throw new NotFoundException('Enrollment not found');
    if (enrollment.status !== EnrollmentStatus.APPROVED) {
      throw new BadRequestException('Seules les inscriptions approuvées peuvent être synchronisées');
    }
    return this.prisma.$transaction((tx) => this.setupAfterApproval(tx, enrollmentId));
  }

  /**
   * Supprime la scolarité annuelle et les mensualités encore en attente, puis régénère à partir des barèmes actuels.
   * Les lignes déjà payées ne sont pas supprimées.
   */
  async resetPendingBillingAndRegenerate(enrollmentId: string) {
    const enrollment = await this.prisma.enrollment.findUnique({
      where: { id: enrollmentId },
      select: { status: true },
    });
    if (!enrollment) throw new NotFoundException('Inscription introuvable.');
    if (enrollment.status !== EnrollmentStatus.APPROVED) {
      throw new BadRequestException(
        'Seules les inscriptions validées peuvent être recalculées.',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const deletedTuition = await tx.tuitionCharge.deleteMany({
        where: { enrollmentId, status: PaymentStatus.PENDING },
      });
      const deletedMonthly = await tx.monthlyInstallment.deleteMany({
        where: { enrollmentId, status: PaymentStatus.PENDING },
      });

      const result = await this.setupAfterApproval(tx, enrollmentId);

      return {
        deleted: {
          tuitionCharges: deletedTuition.count,
          monthlyInstallments: deletedMonthly.count,
        },
        tuitionCreated: result.tuitionCreated,
        monthsGenerated: result.monthsGenerated,
        warnings: result.warnings,
      };
    });
  }
}
