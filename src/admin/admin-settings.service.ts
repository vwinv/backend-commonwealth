import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EnrollmentStatus, Prisma, SchoolYearStatus } from '@prisma/client';
import { BillingService } from '../billing/billing.service';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AdminSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly billing: BillingService,
  ) {}

  private parseDate(raw: unknown, field: string): Date {
    const s = String(raw ?? '').trim();
    if (!s) throw new BadRequestException(`${field} est obligatoire.`);
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) {
      throw new BadRequestException(`${field} invalide.`);
    }
    return d;
  }

  async getActiveSchoolYear() {
    const current = await this.prisma.schoolYear.findFirst({
      where: { status: SchoolYearStatus.OPEN },
      orderBy: { startDate: 'desc' },
    });
    return { active: current };
  }

  async listSchoolYears() {
    const rows = await this.prisma.schoolYear.findMany({
      orderBy: [{ startDate: 'desc' }, { createdAt: 'desc' }],
    });
    return { items: rows };
  }

  async createSchoolYear(body: Record<string, unknown>) {
    const label = String(body?.label ?? '').trim();
    if (!label) throw new BadRequestException('Le libellé est obligatoire.');
    const startDate = this.parseDate(body?.startDate, 'La date de début');
    const endDate = this.parseDate(body?.endDate, 'La date de fin');
    if (endDate <= startDate) {
      throw new BadRequestException('La date de fin doit être après la date de début.');
    }
    const openNow = Boolean(body?.openNow ?? true);

    try {
      return await this.prisma.$transaction(async (tx) => {
        if (openNow) {
          await tx.schoolYear.updateMany({
            where: { status: SchoolYearStatus.OPEN },
            data: { status: SchoolYearStatus.CLOSED },
          });
        }
        return tx.schoolYear.create({
          data: {
            label,
            startDate,
            endDate,
            status: openNow ? SchoolYearStatus.OPEN : SchoolYearStatus.CLOSED,
          },
        });
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new BadRequestException('Cette année scolaire existe déjà.');
      }
      throw e;
    }
  }

  async closeSchoolYear(id: string) {
    const existing = await this.prisma.schoolYear.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Année scolaire introuvable.');
    if (existing.status === SchoolYearStatus.CLOSED) return existing;
    return this.prisma.schoolYear.update({
      where: { id },
      data: { status: SchoolYearStatus.CLOSED },
    });
  }

  async openSchoolYear(id: string) {
    const existing = await this.prisma.schoolYear.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Année scolaire introuvable.');
    return this.prisma.$transaction(async (tx) => {
      await tx.schoolYear.updateMany({
        where: { status: SchoolYearStatus.OPEN },
        data: { status: SchoolYearStatus.CLOSED },
      });
      return tx.schoolYear.update({
        where: { id },
        data: { status: SchoolYearStatus.OPEN },
      });
    });
  }

  async ensureSchoolYearExists(schoolYear: string) {
    const sy = schoolYear.trim();
    const row = await this.prisma.schoolYear.findUnique({ where: { label: sy } });
    if (!row) {
      throw new BadRequestException(`Année scolaire inconnue: ${sy}`);
    }
    return row;
  }

  async getCatalog(schoolYear?: string) {
    let sy = String(schoolYear ?? '').trim();
    if (!sy) {
      const active = await this.prisma.schoolYear.findFirst({
        where: { status: SchoolYearStatus.OPEN },
        orderBy: { startDate: 'desc' },
      });
      if (!active) {
        throw new BadRequestException('Aucune année scolaire ouverte.');
      }
      sy = active.label;
    }

    const levels = await this.prisma.level.findMany({
      orderBy: [{ order: 'asc' }, { name: 'asc' }],
      include: {
        classes: { orderBy: { name: 'asc' } },
        schoolYearPricings: { where: { schoolYear: sy } },
      },
    });

    return {
      schoolYear: sy,
      levels: levels.map((l) => ({
        id: l.id,
        name: l.name,
        order: l.order,
        classes: l.classes.map((c) => ({ id: c.id, name: c.name })),
        pricing: l.schoolYearPricings[0]
          ? {
              id: l.schoolYearPricings[0].id,
              annualTuitionCents: l.schoolYearPricings[0].annualTuitionCents,
              monthlyBaseCents: l.schoolYearPricings[0].monthlyBaseCents,
            }
          : null,
      })),
    };
  }

  async createLevel(body: Record<string, unknown>) {
    const name = String(body?.name ?? '').trim();
    const schoolYear = String(body?.schoolYear ?? '').trim();
    const annualTuitionCents = Number(body?.annualTuitionCents);
    const monthlyBaseCents = Number(body?.monthlyBaseCents);
    const orderRaw = body?.order;
    const order =
      orderRaw === undefined || orderRaw === null || orderRaw === ''
        ? null
        : Number(orderRaw);

    if (!name) throw new BadRequestException('Le nom du niveau est obligatoire.');
    if (!schoolYear) throw new BadRequestException("L'année scolaire est obligatoire.");
    await this.ensureSchoolYearExists(schoolYear);
    if (!Number.isInteger(annualTuitionCents) || annualTuitionCents < 0) {
      throw new BadRequestException(
        'Le montant d’inscription (centimes) doit être un entier positif ou nul.',
      );
    }
    if (!Number.isInteger(monthlyBaseCents) || monthlyBaseCents < 0) {
      throw new BadRequestException(
        'Le montant de mensualité (centimes) doit être un entier positif ou nul.',
      );
    }
    if (order !== null && !Number.isInteger(order)) {
      throw new BadRequestException("L'ordre d'affichage doit être un entier.");
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const level = await tx.level.create({
          data: { name, order: order ?? undefined },
        });
        const pricing = await tx.levelSchoolYearPricing.create({
          data: {
            levelId: level.id,
            schoolYear,
            annualTuitionCents,
            monthlyBaseCents,
          },
        });
        return {
          level: {
            id: level.id,
            name: level.name,
            order: level.order,
          },
          pricing: {
            id: pricing.id,
            schoolYear: pricing.schoolYear,
            annualTuitionCents: pricing.annualTuitionCents,
            monthlyBaseCents: pricing.monthlyBaseCents,
          },
        };
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new BadRequestException('Un niveau avec ce nom existe déjà.');
      }
      throw e;
    }
  }

  async upsertLevelPricing(levelId: string, body: Record<string, unknown>) {
    const schoolYear = String(body?.schoolYear ?? '').trim();
    const annualTuitionCents = Number(body?.annualTuitionCents);
    const monthlyBaseCents = Number(body?.monthlyBaseCents);

    if (!schoolYear) throw new BadRequestException("L'année scolaire est obligatoire.");
    await this.ensureSchoolYearExists(schoolYear);
    if (!Number.isInteger(annualTuitionCents) || annualTuitionCents < 0) {
      throw new BadRequestException(
        'Le montant d’inscription (centimes) doit être un entier positif ou nul.',
      );
    }
    if (!Number.isInteger(monthlyBaseCents) || monthlyBaseCents < 0) {
      throw new BadRequestException(
        'Le montant de mensualité (centimes) doit être un entier positif ou nul.',
      );
    }

    const level = await this.prisma.level.findUnique({ where: { id: levelId }, select: { id: true } });
    if (!level) throw new NotFoundException('Niveau introuvable.');

    const pricing = await this.prisma.levelSchoolYearPricing.upsert({
      where: { schoolYear_levelId: { schoolYear, levelId } },
      update: { annualTuitionCents, monthlyBaseCents },
      create: { schoolYear, levelId, annualTuitionCents, monthlyBaseCents },
    });
    const regeneratePending = body?.regeneratePending === true;
    if (!regeneratePending) {
      return { pricing, regeneration: null };
    }
    const regeneration = await this.regeneratePendingInvoicesForLevelPricing(levelId, { schoolYear });
    return { pricing, regeneration };
  }

  async regeneratePendingInvoicesForLevelPricing(levelId: string, body: Record<string, unknown>) {
    const schoolYear = String(body?.schoolYear ?? '').trim();
    if (!schoolYear) throw new BadRequestException("L'année scolaire est obligatoire.");
    await this.ensureSchoolYearExists(schoolYear);

    const level = await this.prisma.level.findUnique({ where: { id: levelId }, select: { id: true } });
    if (!level) throw new NotFoundException('Niveau introuvable.');

    const enrollments = await this.prisma.enrollment.findMany({
      where: {
        levelId,
        schoolYear,
        status: EnrollmentStatus.APPROVED,
      },
      select: { id: true },
      orderBy: { createdAt: 'desc' },
    });

    let done = 0;
    let pendingDeletedTuition = 0;
    let pendingDeletedMonthly = 0;
    const warnings: string[] = [];

    for (const e of enrollments) {
      const res = await this.billing.resetPendingBillingAndRegenerate(e.id);
      done += 1;
      pendingDeletedTuition += res.deleted.tuitionCharges;
      pendingDeletedMonthly += res.deleted.monthlyInstallments;
      if (res.warnings?.length) warnings.push(...res.warnings.map((w) => `[${e.id}] ${w}`));
    }

    return {
      schoolYear,
      levelId,
      enrollmentsFound: enrollments.length,
      enrollmentsProcessed: done,
      deleted: {
        tuitionCharges: pendingDeletedTuition,
        monthlyInstallments: pendingDeletedMonthly,
      },
      warnings: [...new Set(warnings)],
    };
  }

  async createClass(body: Record<string, unknown>) {
    const levelId = String(body?.levelId ?? '').trim();
    const name = String(body?.name ?? '').trim();
    if (!levelId) throw new BadRequestException('Le niveau est obligatoire.');
    if (!name) throw new BadRequestException('Le nom de la classe est obligatoire.');

    try {
      return await this.prisma.classRoom.create({
        data: { levelId, name },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2003') {
        throw new NotFoundException('Niveau introuvable.');
      }
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new BadRequestException('Cette classe existe déjà pour ce niveau.');
      }
      throw e;
    }
  }

  async listServiceTariffs() {
    const items = await this.prisma.serviceTariff.findMany({
      orderBy: [{ code: 'asc' }],
    });
    return { items };
  }

  async createServiceTariff(body: Record<string, unknown>) {
    const code = String(body?.code ?? '').trim().toUpperCase();
    const label = String(body?.label ?? '').trim();
    if (!code) throw new BadRequestException('Le code du service est obligatoire.');
    if (!label) throw new BadRequestException('Le libellé du service est obligatoire.');
    try {
      return await this.prisma.serviceTariff.create({
        data: { code, label, active: body?.active !== false },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new BadRequestException('Ce code service existe déjà.');
      }
      throw e;
    }
  }

  async listServicePrices(schoolYear: string, levelId: string) {
    const sy = String(schoolYear ?? '').trim();
    const lid = String(levelId ?? '').trim();
    if (!sy) throw new BadRequestException("L'année scolaire est obligatoire.");
    if (!lid) throw new BadRequestException('Le niveau est obligatoire.');
    await this.ensureSchoolYearExists(sy);

    const [services, prices] = await Promise.all([
      this.prisma.serviceTariff.findMany({
        where: { active: true },
        orderBy: [{ code: 'asc' }],
      }),
      this.prisma.serviceLevelPrice.findMany({
        where: { schoolYear: sy, levelId: lid },
      }),
    ]);

    const byService = new Map(prices.map((p) => [p.serviceTariffId, p]));
    return {
      schoolYear: sy,
      levelId: lid,
      items: services.map((s) => ({
        id: s.id,
        code: s.code,
        label: s.label,
        active: s.active,
        monthlyAmountCents: byService.get(s.id)?.monthlyAmountCents ?? 0,
      })),
    };
  }

  async upsertServicePrice(body: Record<string, unknown>) {
    const schoolYear = String(body?.schoolYear ?? '').trim();
    const levelId = String(body?.levelId ?? '').trim();
    const serviceTariffId = String(body?.serviceTariffId ?? '').trim();
    const monthlyAmountCents = Number(body?.monthlyAmountCents);
    if (!schoolYear || !levelId || !serviceTariffId) {
      throw new BadRequestException('schoolYear, levelId et serviceTariffId sont obligatoires.');
    }
    await this.ensureSchoolYearExists(schoolYear);
    if (!Number.isInteger(monthlyAmountCents) || monthlyAmountCents < 0) {
      throw new BadRequestException('Le tarif mensuel doit être un entier positif ou nul (centimes).');
    }

    return this.prisma.serviceLevelPrice.upsert({
      where: { schoolYear_levelId_serviceTariffId: { schoolYear, levelId, serviceTariffId } },
      update: { monthlyAmountCents },
      create: { schoolYear, levelId, serviceTariffId, monthlyAmountCents },
      include: { serviceTariff: true, level: true },
    });
  }

  async regeneratePendingInvoicesForServicePrice(body: Record<string, unknown>) {
    const schoolYear = String(body?.schoolYear ?? '').trim();
    const levelId = String(body?.levelId ?? '').trim();
    const serviceTariffId = String(body?.serviceTariffId ?? '').trim();
    if (!schoolYear || !levelId || !serviceTariffId) {
      throw new BadRequestException('schoolYear, levelId et serviceTariffId sont obligatoires.');
    }
    await this.ensureSchoolYearExists(schoolYear);

    const enrollments = await this.prisma.enrollment.findMany({
      where: {
        schoolYear,
        levelId,
        status: EnrollmentStatus.APPROVED,
        serviceSubscriptions: {
          some: { serviceTariffId },
        },
      },
      select: { id: true },
      orderBy: { createdAt: 'desc' },
    });

    let done = 0;
    let pendingDeletedTuition = 0;
    let pendingDeletedMonthly = 0;
    const warnings: string[] = [];

    for (const e of enrollments) {
      const res = await this.billing.resetPendingBillingAndRegenerate(e.id);
      done += 1;
      pendingDeletedTuition += res.deleted.tuitionCharges;
      pendingDeletedMonthly += res.deleted.monthlyInstallments;
      if (res.warnings?.length) warnings.push(...res.warnings.map((w) => `[${e.id}] ${w}`));
    }

    return {
      schoolYear,
      levelId,
      serviceTariffId,
      enrollmentsFound: enrollments.length,
      enrollmentsProcessed: done,
      deleted: {
        tuitionCharges: pendingDeletedTuition,
        monthlyInstallments: pendingDeletedMonthly,
      },
      warnings: [...new Set(warnings)],
    };
  }

  /** Niveaux pour listes (documents, etc.) — ne dépend pas d’une année scolaire ouverte. */
  async listLevelsForSelect() {
    const levels = await this.prisma.level.findMany({
      orderBy: [{ order: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true },
    });
    return { levels };
  }
}
