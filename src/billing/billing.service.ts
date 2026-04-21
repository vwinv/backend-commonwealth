import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  EnrollmentStatus,
  MonthlyBillingLineKind,
  PaymentStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { billingMonthsForSchoolYear } from './school-year';

export type BillingTx = Omit<
  Prisma.TransactionClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(private readonly prisma: PrismaService) {}

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
    const byCode = new Map(tariffs.map((t) => [t.code.toUpperCase(), t]));
    for (const code of normalized) {
      const t = byCode.get(code);
      if (!t) continue;
      await tx.enrollmentServiceSubscription.upsert({
        where: {
          enrollmentId_serviceTariffId: { enrollmentId, serviceTariffId: t.id },
        },
        update: {},
        create: { enrollmentId, serviceTariffId: t.id },
      });
    }
  }

  /**
   * Après validation admin : scolarité annuelle + échéances mensuelles (mensualité + services).
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
      },
    });
    if (!enrollment || enrollment.status !== EnrollmentStatus.APPROVED) {
      return { tuitionCreated: false, monthsGenerated: 0, warnings: ['Inscription introuvable ou non approuvée'] };
    }

    const warnings: string[] = [];
    const pricing = await tx.levelSchoolYearPricing.findUnique({
      where: {
        schoolYear_levelId: { schoolYear: enrollment.schoolYear, levelId: enrollment.levelId },
      },
    });

    if (!pricing) {
      warnings.push(
        `Aucun barème pour l’année « ${enrollment.schoolYear} » et ce niveau : la scolarité et les mensualités ne sont pas générées.`,
      );
      return { tuitionCreated: false, monthsGenerated: 0, warnings };
    }

    const existingTuition = await tx.tuitionCharge.findUnique({
      where: {
        enrollmentId_schoolYear: { enrollmentId, schoolYear: enrollment.schoolYear },
      },
    });
    if (!existingTuition) {
      await tx.tuitionCharge.create({
        data: {
          enrollmentId,
          schoolYear: enrollment.schoolYear,
          amountCents: pricing.annualTuitionCents,
          status: PaymentStatus.PENDING,
        },
      });
    } else if (existingTuition.status === PaymentStatus.PENDING) {
      await tx.tuitionCharge.update({
        where: { id: existingTuition.id },
        data: { amountCents: pricing.annualTuitionCents },
      });
    }

    const months = billingMonthsForSchoolYear(enrollment.schoolYear);
    if (months.length === 0) {
      warnings.push(`Format d’année scolaire invalide : « ${enrollment.schoolYear} » (attendu ex. 2025-2026).`);
      return { tuitionCreated: true, monthsGenerated: 0, warnings };
    }

    const subs = await tx.enrollmentServiceSubscription.findMany({
      where: { enrollmentId },
      include: { serviceTariff: true },
    });

    let monthsGenerated = 0;
    for (const { year, month } of months) {
      const lines: { kind: MonthlyBillingLineKind; serviceTariffId: string | null; label: string; amountCents: number }[] =
        [];

      lines.push({
        kind: MonthlyBillingLineKind.MONTHLY_BASE,
        serviceTariffId: null,
        label: 'Mensualité',
        amountCents: pricing.monthlyBaseCents,
      });

      for (const sub of subs) {
        const sp = await tx.serviceLevelPrice.findUnique({
          where: {
            schoolYear_levelId_serviceTariffId: {
              schoolYear: enrollment.schoolYear,
              levelId: enrollment.levelId,
              serviceTariffId: sub.serviceTariffId,
            },
          },
        });
        if (!sp) {
          warnings.push(
            `Pas de tarif mensuel pour le service « ${sub.serviceTariff.label} » (${sub.serviceTariff.code}) sur ce niveau / année.`,
          );
          continue;
        }
        lines.push({
          kind: MonthlyBillingLineKind.SERVICE,
          serviceTariffId: sub.serviceTariffId,
          label: sub.serviceTariff.label,
          amountCents: sp.monthlyAmountCents,
        });
      }

      const totalAmountCents = lines.reduce((s, l) => s + l.amountCents, 0);

      const existing = await tx.monthlyInstallment.findUnique({
        where: {
          enrollmentId_year_month: { enrollmentId, year, month },
        },
        select: { id: true, status: true },
      });

      if (existing?.status === PaymentStatus.PAID) {
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

    return { tuitionCreated: true, monthsGenerated, warnings: [...new Set(warnings)] };
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
