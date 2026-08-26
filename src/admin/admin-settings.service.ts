import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EnrollmentStatus, OptionPricingMode, Prisma, SchoolYearStatus, ServiceBillingPeriod } from '@prisma/client';
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

  async getSchoolYearDeletionImpact(id: string) {
    const existing = await this.prisma.schoolYear.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Année scolaire introuvable.');
    return this.buildSchoolYearDeletionImpact(existing);
  }

  async deleteSchoolYear(id: string) {
    const existing = await this.prisma.schoolYear.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Année scolaire introuvable.');
    const label = existing.label;

    try {
      const result = await this.prisma.$transaction(
        async (tx) => {
          await tx.tuitionCharge.deleteMany({ where: { schoolYear: label } });
          await tx.enrollment.deleteMany({ where: { schoolYear: label } });
          await tx.programEvent.deleteMany({ where: { schoolYear: label } });
          await tx.levelSchedule.deleteMany({ where: { schoolYear: label } });
          await tx.levelSchoolYearPricing.deleteMany({ where: { schoolYear: label } });
          await tx.serviceLevelPrice.deleteMany({ where: { schoolYear: label } });
          await tx.schoolYear.delete({ where: { id } });

          const remaining = await tx.schoolYear.findMany({
            orderBy: { startDate: 'desc' },
            select: { id: true, label: true, status: true },
          });
          const hasOpen = remaining.some((y) => y.status === SchoolYearStatus.OPEN);
          let reopenedLabel: string | null = null;
          if (!hasOpen && remaining[0]) {
            await tx.schoolYear.update({
              where: { id: remaining[0].id },
              data: { status: SchoolYearStatus.OPEN },
            });
            reopenedLabel = remaining[0].label;
          }
          return { reopenedLabel, remainingLabel: remaining[0]?.label ?? null };
        },
        { timeout: 30000 },
      );

      return { ok: true, label, ...result };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2003') {
        throw new BadRequestException(
          `Impossible de supprimer l’année ${label} : des données liées n’ont pas pu être retirées.`,
        );
      }
      throw e;
    }
  }

  private async buildSchoolYearDeletionImpact(existing: {
    id: string;
    label: string;
    status: SchoolYearStatus;
  }) {
    const label = existing.label;
    const [
      remainingYears,
      nextYear,
      enrollments,
      approvedEnrollments,
      tuitionCharges,
      monthlyInstallments,
      monthlyPayments,
      programEvents,
      schedules,
      pricings,
      servicePrices,
    ] = await Promise.all([
      this.prisma.schoolYear.count({ where: { id: { not: existing.id } } }),
      this.prisma.schoolYear.findFirst({
        where: { id: { not: existing.id } },
        orderBy: { startDate: 'desc' },
        select: { label: true },
      }),
      this.prisma.enrollment.count({ where: { schoolYear: label } }),
      this.prisma.enrollment.count({
        where: { schoolYear: label, status: EnrollmentStatus.APPROVED },
      }),
      this.prisma.tuitionCharge.count({ where: { schoolYear: label } }),
      this.prisma.monthlyInstallment.count({
        where: { enrollment: { schoolYear: label } },
      }),
      this.prisma.monthlyPayment.count({
        where: { enrollment: { schoolYear: label } },
      }),
      this.prisma.programEvent.count({ where: { schoolYear: label } }),
      this.prisma.levelSchedule.count({ where: { schoolYear: label } }),
      this.prisma.levelSchoolYearPricing.count({ where: { schoolYear: label } }),
      this.prisma.serviceLevelPrice.count({ where: { schoolYear: label } }),
    ]);

    return {
      id: existing.id,
      label,
      status: existing.status,
      remainingYears,
      willReopenLabel:
        existing.status === SchoolYearStatus.OPEN && remainingYears > 0
          ? (nextYear?.label ?? null)
          : null,
      enrollments,
      approvedEnrollments,
      tuitionCharges,
      monthlyInstallments,
      monthlyPayments,
      programEvents,
      schedules,
      pricings,
      servicePrices,
    };
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
        schedules: {
          where: { schoolYear: sy },
          orderBy: [{ order: 'asc' }, { label: 'asc' }],
        },
      },
    });

    const classIds = levels.flatMap((l) => l.classes.map((c) => c.id));
    const countRows =
      classIds.length > 0
        ? await this.prisma.enrollment.groupBy({
            by: ['classId'],
            where: {
              classId: { in: classIds },
              schoolYear: sy,
              status: EnrollmentStatus.APPROVED,
            },
            _count: { _all: true },
          })
        : [];
    const countByClass = new Map(
      countRows.filter((r) => r.classId).map((r) => [r.classId as string, r._count._all]),
    );

    const levelEnrollmentRows =
      levels.length > 0
        ? await this.prisma.enrollment.groupBy({
            by: ['levelId'],
            _count: { _all: true },
          })
        : [];
    const enrollmentsByLevel = new Map(levelEnrollmentRows.map((r) => [r.levelId, r._count._all]));

    return {
      schoolYear: sy,
      levels: levels.map((l) => ({
        id: l.id,
        name: l.name,
        order: l.order,
        enrollmentCount: enrollmentsByLevel.get(l.id) ?? 0,
        classes: l.classes.map((c) => ({
          id: c.id,
          name: c.name,
          capacity: c.capacity,
          headTeacher: c.headTeacher ?? '',
          studentCount: countByClass.get(c.id) ?? 0,
        })),
        pricing: l.schoolYearPricings[0]
          ? {
              id: l.schoolYearPricings[0].id,
              annualTuitionCents: l.schoolYearPricings[0].annualTuitionCents,
              monthlyBaseCents: l.schoolYearPricings[0].monthlyBaseCents,
            }
          : null,
        schedules: l.schedules.map((s) => ({
          id: s.id,
          label: s.label,
          timeDescription: s.timeDescription ?? '',
          annualTuitionCents: s.annualTuitionCents,
          monthlyBaseCents: s.monthlyBaseCents,
          annualXof: s.annualTuitionCents / 100,
          monthlyXof: s.monthlyBaseCents / 100,
          order: s.order,
          active: s.active,
        })),
      })),
    };
  }

  private parseScheduleRows(raw: unknown) {
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new BadRequestException('Au moins un horaire est obligatoire.');
    }
    return raw.map((row, index) => {
      const r = row as Record<string, unknown>;
      const label = String(r.label ?? '').trim();
      if (!label) {
        throw new BadRequestException(`Horaire ${index + 1} : le libellé est obligatoire.`);
      }
      const annualTuitionCents = Number(r.annualTuitionCents);
      const monthlyBaseCents = Number(r.monthlyBaseCents);
      if (!Number.isInteger(annualTuitionCents) || annualTuitionCents < 0) {
        throw new BadRequestException(`Horaire « ${label} » : inscription invalide.`);
      }
      if (!Number.isInteger(monthlyBaseCents) || monthlyBaseCents < 0) {
        throw new BadRequestException(`Horaire « ${label} » : mensualité invalide.`);
      }
      const orderRaw = r.order;
      const order =
        orderRaw === undefined || orderRaw === null || orderRaw === ''
          ? index + 1
          : Number(orderRaw);
      if (!Number.isInteger(order)) {
        throw new BadRequestException(`Horaire « ${label} » : ordre invalide.`);
      }
      return {
        label,
        timeDescription: String(r.timeDescription ?? '').trim() || null,
        annualTuitionCents,
        monthlyBaseCents,
        order,
        active: r.active !== false,
      };
    });
  }

  async getLevelSchedules(levelId: string, schoolYear: string) {
    const sy = String(schoolYear ?? '').trim();
    if (!sy) throw new BadRequestException("L'année scolaire est obligatoire.");
    await this.ensureSchoolYearExists(sy);
    const level = await this.prisma.level.findUnique({ where: { id: levelId }, select: { id: true, name: true } });
    if (!level) throw new NotFoundException('Niveau introuvable.');

    const schedules = await this.prisma.levelSchedule.findMany({
      where: { levelId, schoolYear: sy },
      orderBy: [{ order: 'asc' }, { label: 'asc' }],
    });
    return {
      level,
      schoolYear: sy,
      schedules: schedules.map((s) => ({
        id: s.id,
        label: s.label,
        timeDescription: s.timeDescription ?? '',
        annualTuitionCents: s.annualTuitionCents,
        monthlyBaseCents: s.monthlyBaseCents,
        annualXof: s.annualTuitionCents / 100,
        monthlyXof: s.monthlyBaseCents / 100,
        order: s.order,
        active: s.active,
      })),
    };
  }

  async replaceLevelSchedules(levelId: string, body: Record<string, unknown>) {
    const schoolYear = String(body?.schoolYear ?? '').trim();
    if (!schoolYear) throw new BadRequestException("L'année scolaire est obligatoire.");
    await this.ensureSchoolYearExists(schoolYear);
    const level = await this.prisma.level.findUnique({ where: { id: levelId }, select: { id: true } });
    if (!level) throw new NotFoundException('Niveau introuvable.');

    const rows = this.parseScheduleRows(body?.schedules);
    return this.persistLevelSchedules(levelId, schoolYear, rows);
  }

  async updateLevel(levelId: string, body: Record<string, unknown>) {
    const schoolYear = String(body?.schoolYear ?? '').trim();
    if (!schoolYear) throw new BadRequestException("L'année scolaire est obligatoire.");
    await this.ensureSchoolYearExists(schoolYear);

    const existing = await this.prisma.level.findUnique({ where: { id: levelId }, select: { id: true } });
    if (!existing) throw new NotFoundException('Niveau introuvable.');

    const name = String(body?.name ?? '').trim();
    if (!name) throw new BadRequestException('Le nom du niveau est obligatoire.');

    const orderRaw = body?.order;
    const order =
      orderRaw === undefined || orderRaw === null || orderRaw === ''
        ? null
        : Number(orderRaw);
    if (order !== null && !Number.isInteger(order)) {
      throw new BadRequestException("L'ordre d'affichage doit être un entier.");
    }

    const rows = this.parseScheduleRows(body?.schedules);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const level = await tx.level.update({
          where: { id: levelId },
          data: { name, order: order ?? undefined },
        });

        await tx.levelSchedule.deleteMany({ where: { levelId, schoolYear } });
        const created = await Promise.all(
          rows.map((row) =>
            tx.levelSchedule.create({
              data: {
                levelId,
                schoolYear,
                label: row.label,
                timeDescription: row.timeDescription,
                annualTuitionCents: row.annualTuitionCents,
                monthlyBaseCents: row.monthlyBaseCents,
                order: row.order,
                active: row.active,
              },
            }),
          ),
        );

        const first = rows[0]!;
        await tx.levelSchoolYearPricing.upsert({
          where: { schoolYear_levelId: { schoolYear, levelId } },
          update: {
            annualTuitionCents: first.annualTuitionCents,
            monthlyBaseCents: first.monthlyBaseCents,
          },
          create: {
            schoolYear,
            levelId,
            annualTuitionCents: first.annualTuitionCents,
            monthlyBaseCents: first.monthlyBaseCents,
          },
        });

        return {
          level: { id: level.id, name: level.name, order: level.order },
          schedules: created.map((s) => ({
            id: s.id,
            label: s.label,
            timeDescription: s.timeDescription ?? '',
            annualTuitionCents: s.annualTuitionCents,
            monthlyBaseCents: s.monthlyBaseCents,
            annualXof: s.annualTuitionCents / 100,
            monthlyXof: s.monthlyBaseCents / 100,
            order: s.order,
            active: s.active,
          })),
        };
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new BadRequestException('Un niveau avec ce nom existe déjà.');
      }
      throw e;
    }
  }

  async deleteLevel(levelId: string) {
    const existing = await this.prisma.level.findUnique({
      where: { id: levelId },
      select: { id: true, name: true },
    });
    if (!existing) throw new NotFoundException('Niveau introuvable.');

    const enrollmentCount = await this.prisma.enrollment.count({ where: { levelId } });
    if (enrollmentCount > 0) {
      throw new BadRequestException(
        enrollmentCount === 1
          ? `Impossible de supprimer « ${existing.name} » : 1 dossier d’inscription y est encore rattaché.`
          : `Impossible de supprimer « ${existing.name} » : ${enrollmentCount} dossiers d’inscription y sont encore rattachés.`,
      );
    }

    const classWithPupils = await this.prisma.classRoom.count({
      where: { levelId, enrollments: { some: {} } },
    });
    if (classWithPupils > 0) {
      throw new BadRequestException(
        'Impossible de supprimer ce niveau : une classe contient encore des inscriptions.',
      );
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.classRoom.deleteMany({ where: { levelId } });
        await tx.level.delete({ where: { id: levelId } });
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2003') {
        throw new BadRequestException(
          `Impossible de supprimer « ${existing.name} » : des données y sont encore liées.`,
        );
      }
      throw e;
    }
    return { ok: true };
  }

  private async persistLevelSchedules(
    levelId: string,
    schoolYear: string,
    rows: ReturnType<AdminSettingsService['parseScheduleRows']>,
  ) {
    const first = rows[0]!;

    return this.prisma.$transaction(async (tx) => {
      await tx.levelSchedule.deleteMany({ where: { levelId, schoolYear } });
      const created = await Promise.all(
        rows.map((row) =>
          tx.levelSchedule.create({
            data: {
              levelId,
              schoolYear,
              label: row.label,
              timeDescription: row.timeDescription,
              annualTuitionCents: row.annualTuitionCents,
              monthlyBaseCents: row.monthlyBaseCents,
              order: row.order,
              active: row.active,
            },
          }),
        ),
      );

      await tx.levelSchoolYearPricing.upsert({
        where: { schoolYear_levelId: { schoolYear, levelId } },
        update: {
          annualTuitionCents: first.annualTuitionCents,
          monthlyBaseCents: first.monthlyBaseCents,
        },
        create: {
          schoolYear,
          levelId,
          annualTuitionCents: first.annualTuitionCents,
          monthlyBaseCents: first.monthlyBaseCents,
        },
      });

      return {
        schedules: created.map((s) => ({
          id: s.id,
          label: s.label,
          timeDescription: s.timeDescription ?? '',
          annualTuitionCents: s.annualTuitionCents,
          monthlyBaseCents: s.monthlyBaseCents,
          annualXof: s.annualTuitionCents / 100,
          monthlyXof: s.monthlyBaseCents / 100,
          order: s.order,
          active: s.active,
        })),
      };
    });
  }

  async createLevel(body: Record<string, unknown>) {
    const name = String(body?.name ?? '').trim();
    const schoolYear = String(body?.schoolYear ?? '').trim();
    const orderRaw = body?.order;
    const order =
      orderRaw === undefined || orderRaw === null || orderRaw === ''
        ? null
        : Number(orderRaw);

    if (!name) throw new BadRequestException('Le nom du niveau est obligatoire.');
    if (!schoolYear) throw new BadRequestException("L'année scolaire est obligatoire.");
    await this.ensureSchoolYearExists(schoolYear);
    if (order !== null && !Number.isInteger(order)) {
      throw new BadRequestException("L'ordre d'affichage doit être un entier.");
    }

    const schedulesIn = Array.isArray(body?.schedules) ? body.schedules : [];
    let annualTuitionCents: number;
    let monthlyBaseCents: number;
    let scheduleRows: ReturnType<AdminSettingsService['parseScheduleRows']> | null = null;

    if (schedulesIn.length > 0) {
      scheduleRows = this.parseScheduleRows(schedulesIn);
      annualTuitionCents = scheduleRows[0]!.annualTuitionCents;
      monthlyBaseCents = scheduleRows[0]!.monthlyBaseCents;
    } else {
      annualTuitionCents = Number(body?.annualTuitionCents);
      monthlyBaseCents = Number(body?.monthlyBaseCents);
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

        let schedules: Array<{
          id: string;
          label: string;
          timeDescription: string;
          annualTuitionCents: number;
          monthlyBaseCents: number;
        }> = [];

        if (scheduleRows?.length) {
          const createdSchedules = await Promise.all(
            scheduleRows.map((row) =>
              tx.levelSchedule.create({
                data: {
                  levelId: level.id,
                  schoolYear,
                  label: row.label,
                  timeDescription: row.timeDescription,
                  annualTuitionCents: row.annualTuitionCents,
                  monthlyBaseCents: row.monthlyBaseCents,
                  order: row.order,
                  active: row.active,
                },
              }),
            ),
          );
          schedules = createdSchedules.map((s) => ({
            id: s.id,
            label: s.label,
            timeDescription: s.timeDescription ?? '',
            annualTuitionCents: s.annualTuitionCents,
            monthlyBaseCents: s.monthlyBaseCents,
          }));
        }

        const tariffs = await tx.serviceTariff.findMany({ where: { active: true }, select: { id: true } });
        if (tariffs.length) {
          await tx.serviceLevelPrice.createMany({
            data: tariffs.map((t) => ({
              schoolYear,
              levelId: level.id,
              serviceTariffId: t.id,
              monthlyAmountCents: 0,
            })),
            skipDuplicates: true,
          });
        }

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
          schedules,
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
    const headTeacher = String(body?.headTeacher ?? '').trim() || null;
    const capacityRaw = body?.capacity;
    const capacity =
      capacityRaw === undefined || capacityRaw === null || capacityRaw === ''
        ? 22
        : Number(capacityRaw);
    if (!levelId) throw new BadRequestException('Le niveau est obligatoire.');
    if (!name) throw new BadRequestException('Le nom de la classe est obligatoire.');
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new BadRequestException("L'effectif maximum doit être un entier positif.");
    }

    try {
      return await this.prisma.classRoom.create({
        data: { levelId, name, capacity, headTeacher },
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

  async updateClass(id: string, body: Record<string, unknown>) {
    const existing = await this.prisma.classRoom.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Classe introuvable.');

    const data: Prisma.ClassRoomUpdateInput = {};
    if (body?.name !== undefined) {
      const name = String(body.name).trim();
      if (!name) throw new BadRequestException('Le nom de la classe est obligatoire.');
      data.name = name;
    }
    if (body?.headTeacher !== undefined) {
      data.headTeacher = String(body.headTeacher).trim() || null;
    }
    if (body?.capacity !== undefined) {
      const capacity = Number(body.capacity);
      if (!Number.isInteger(capacity) || capacity < 1) {
        throw new BadRequestException("L'effectif maximum doit être un entier positif.");
      }
      const sy = String(body?.schoolYear ?? '').trim() || (await this.resolveSchoolYearForServices());
      if (sy) {
        const enrolled = await this.prisma.enrollment.count({
          where: { classId: id, schoolYear: sy, status: EnrollmentStatus.APPROVED },
        });
        if (capacity < enrolled) {
          throw new BadRequestException(
            `L'effectif maximum ne peut pas être inférieur au nombre d'élèves inscrits (${enrolled}).`,
          );
        }
      }
      data.capacity = capacity;
    }

    try {
      return await this.prisma.classRoom.update({ where: { id }, data });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new BadRequestException('Cette classe existe déjà pour ce niveau.');
      }
      throw e;
    }
  }

  async deleteClass(id: string) {
    const existing = await this.prisma.classRoom.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Classe introuvable.');

    const linked = await this.prisma.enrollment.count({
      where: { classId: id, status: EnrollmentStatus.APPROVED },
    });
    if (linked > 0) {
      throw new BadRequestException('Impossible de supprimer une classe avec des élèves inscrits.');
    }

    await this.prisma.classRoom.delete({ where: { id } });
    return { ok: true };
  }

  async listServiceTariffs(schoolYear?: string) {
    let sy = String(schoolYear ?? '').trim();
    if (!sy) {
      const active = await this.prisma.schoolYear.findFirst({
        where: { status: SchoolYearStatus.OPEN },
        orderBy: { startDate: 'desc' },
      });
      sy = active?.label ?? '';
    }

    const items = await this.prisma.serviceTariff.findMany({
      orderBy: [{ label: 'asc' }],
      include: {
        variants: { orderBy: [{ order: 'asc' }, { label: 'asc' }] },
      },
    });

    const countRows =
      sy.length > 0
        ? await this.prisma.enrollmentServiceSubscription.groupBy({
            by: ['serviceTariffId'],
            where: {
              enrollment: {
                schoolYear: sy,
                status: EnrollmentStatus.APPROVED,
              },
            },
            _count: { _all: true },
          })
        : [];
    const subsByService = new Map(countRows.map((r) => [r.serviceTariffId, r._count._all]));

    return {
      schoolYear: sy,
      items: items.map((s) => ({
        id: s.id,
        code: s.code,
        label: s.label,
        active: s.active,
        amountCents: s.amountCents,
        amountXof: s.amountCents / 100,
        billingPeriod: s.billingPeriod,
        billingPeriodLabel: s.billingPeriod === ServiceBillingPeriod.YEARLY ? 'annuel' : 'mensuel',
        pricingMode: s.pricingMode,
        pricingModeLabel: s.pricingMode === OptionPricingMode.CUSTOMIZABLE ? 'Personnalisable' : 'Prix unique',
        subscriberCount: subsByService.get(s.id) ?? 0,
        variants: s.variants.map((v) => ({
          id: v.id,
          code: v.code,
          label: v.label,
          amountCents: v.amountCents,
          amountXof: v.amountCents / 100,
          billingPeriod: v.billingPeriod,
          billingPeriodLabel: v.billingPeriod === ServiceBillingPeriod.YEARLY ? 'annuel' : 'mensuel',
          order: v.order,
          active: v.active,
        })),
      })),
    };
  }

  private parsePricingMode(raw: unknown): OptionPricingMode {
    const v = String(raw ?? 'FLAT').trim().toUpperCase();
    if (v === 'CUSTOMIZABLE') return OptionPricingMode.CUSTOMIZABLE;
    return OptionPricingMode.FLAT;
  }

  private parseVariantRows(raw: unknown) {
    if (!Array.isArray(raw)) return [];
    return raw
      .map((row, index) => {
        const r = row as Record<string, unknown>;
        const code = String(r.code ?? '').trim().toUpperCase();
        const label = String(r.label ?? '').trim();
        if (!code || !label) return null;
        const amountCents = Number(r.amountCents ?? 0);
        if (!Number.isInteger(amountCents) || amountCents < 0) {
          throw new BadRequestException(`Variante « ${label} » : tarif invalide.`);
        }
        const orderRaw = r.order;
        const order =
          orderRaw === undefined || orderRaw === null || orderRaw === ''
            ? index + 1
            : Number(orderRaw);
        return {
          code,
          label,
          amountCents,
          billingPeriod: this.parseBillingPeriod(r.billingPeriod),
          order: Number.isInteger(order) ? order : index + 1,
          active: r.active !== false,
        };
      })
      .filter(Boolean) as Array<{
      code: string;
      label: string;
      amountCents: number;
      billingPeriod: ServiceBillingPeriod;
      order: number;
      active: boolean;
    }>;
  }

  private parseBillingPeriod(raw: unknown): ServiceBillingPeriod {
    const v = String(raw ?? 'MONTHLY').trim().toUpperCase();
    if (v === 'YEARLY') return ServiceBillingPeriod.YEARLY;
    return ServiceBillingPeriod.MONTHLY;
  }

  private monthlyAmountForLevels(amountCents: number, period: ServiceBillingPeriod): number {
    if (period === ServiceBillingPeriod.YEARLY) {
      return Math.max(0, Math.round(amountCents / 12));
    }
    return amountCents;
  }

  private async syncServicePriceToAllLevels(
    serviceTariffId: string,
    schoolYear: string,
    amountCents: number,
    period: ServiceBillingPeriod,
    variantId: string | null = null,
  ) {
    const monthlyAmountCents = this.monthlyAmountForLevels(amountCents, period);
    const levels = await this.prisma.level.findMany({ select: { id: true } });
    if (levels.length === 0) return;
    await this.prisma.$transaction(async (tx) => {
      for (const level of levels) {
        const existing = await tx.serviceLevelPrice.findFirst({
          where: {
            schoolYear,
            levelId: level.id,
            serviceTariffId,
            variantId,
          },
        });
        if (existing) {
          await tx.serviceLevelPrice.update({
            where: { id: existing.id },
            data: { monthlyAmountCents },
          });
        } else {
          await tx.serviceLevelPrice.create({
            data: {
              schoolYear,
              levelId: level.id,
              serviceTariffId,
              variantId,
              monthlyAmountCents,
            },
          });
        }
      }
    });
  }

  async createServiceTariff(body: Record<string, unknown>) {
    const code = String(body?.code ?? '').trim().toUpperCase();
    const label = String(body?.label ?? '').trim();
    const amountCents = Number(body?.amountCents ?? 0);
    const billingPeriod = this.parseBillingPeriod(body?.billingPeriod);
    const pricingMode = this.parsePricingMode(body?.pricingMode);
    const active = body?.active !== false;
    const sy = String(body?.schoolYear ?? '').trim() || (await this.resolveSchoolYearForServices());
    const variantRows = this.parseVariantRows(body?.variants);

    if (!code) throw new BadRequestException('Le code de l’option est obligatoire.');
    if (!label) throw new BadRequestException('Le libellé de l’option est obligatoire.');
    if (pricingMode === OptionPricingMode.CUSTOMIZABLE && variantRows.length === 0) {
      throw new BadRequestException('Ajoutez au moins une variante pour une option personnalisable.');
    }
    if (pricingMode === OptionPricingMode.FLAT) {
      if (!Number.isInteger(amountCents) || amountCents < 0) {
        throw new BadRequestException('Le tarif doit être un montant entier positif ou nul (centimes).');
      }
    }

    try {
      const created = await this.prisma.serviceTariff.create({
        data: {
          code,
          label,
          active,
          amountCents: pricingMode === OptionPricingMode.FLAT ? amountCents : 0,
          billingPeriod,
          pricingMode,
          variants:
            pricingMode === OptionPricingMode.CUSTOMIZABLE
              ? {
                  create: variantRows.map((v) => ({
                    code: v.code,
                    label: v.label,
                    amountCents: v.amountCents,
                    billingPeriod: v.billingPeriod,
                    order: v.order,
                    active: v.active,
                  })),
                }
              : undefined,
        },
        include: { variants: true },
      });

      if (sy) {
        if (pricingMode === OptionPricingMode.FLAT && amountCents > 0) {
          await this.syncServicePriceToAllLevels(created.id, sy, amountCents, billingPeriod, null);
        }
        if (pricingMode === OptionPricingMode.CUSTOMIZABLE) {
          for (const variant of created.variants) {
            if (variant.amountCents > 0) {
              await this.syncServicePriceToAllLevels(
                created.id,
                sy,
                variant.amountCents,
                variant.billingPeriod,
                variant.id,
              );
            }
          }
        }
      }
      return created;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new BadRequestException('Ce code option existe déjà.');
      }
      throw e;
    }
  }

  async updateServiceTariff(id: string, body: Record<string, unknown>) {
    const existing = await this.prisma.serviceTariff.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Service introuvable.');

    const data: Prisma.ServiceTariffUpdateInput = {};
    if (body?.label !== undefined) {
      const label = String(body.label).trim();
      if (!label) throw new BadRequestException('Le libellé du service est obligatoire.');
      data.label = label;
    }
    if (body?.active !== undefined) data.active = Boolean(body.active);
    if (body?.amountCents !== undefined) {
      const amountCents = Number(body.amountCents);
      if (!Number.isInteger(amountCents) || amountCents < 0) {
        throw new BadRequestException('Le tarif doit être un montant entier positif ou nul (centimes).');
      }
      data.amountCents = amountCents;
    }
    if (body?.billingPeriod !== undefined) {
      data.billingPeriod = this.parseBillingPeriod(body.billingPeriod);
    }
    if (body?.pricingMode !== undefined) {
      data.pricingMode = this.parsePricingMode(body.pricingMode);
    }

    const updated = await this.prisma.serviceTariff.update({ where: { id }, data });

    if (updated.pricingMode === OptionPricingMode.FLAT) {
      await this.prisma.serviceOptionVariant.deleteMany({ where: { serviceTariffId: id } });
    } else if (Array.isArray(body?.variants)) {
      const variantRows = this.parseVariantRows(body.variants);
      if (!variantRows.length) {
        throw new BadRequestException('Au moins une variante est requise.');
      }
      await this.prisma.$transaction(async (tx) => {
        await tx.serviceOptionVariant.deleteMany({ where: { serviceTariffId: id } });
        await tx.serviceOptionVariant.createMany({
          data: variantRows.map((v) => ({
            serviceTariffId: id,
            code: v.code,
            label: v.label,
            amountCents: v.amountCents,
            billingPeriod: v.billingPeriod,
            order: v.order,
            active: v.active,
          })),
        });
      });
    }

    const fresh = await this.prisma.serviceTariff.findUniqueOrThrow({
      where: { id },
      include: { variants: { orderBy: [{ order: 'asc' }, { label: 'asc' }] } },
    });

    const sy = String(body?.schoolYear ?? '').trim() || (await this.resolveSchoolYearForServices());
    if (sy) {
      if (fresh.pricingMode === OptionPricingMode.FLAT) {
        if (body?.amountCents !== undefined || body?.billingPeriod !== undefined) {
          await this.syncServicePriceToAllLevels(
            id,
            sy,
            fresh.amountCents,
            fresh.billingPeriod,
            null,
          );
        }
      } else {
        for (const variant of fresh.variants) {
          await this.syncServicePriceToAllLevels(
            id,
            sy,
            variant.amountCents,
            variant.billingPeriod,
            variant.id,
          );
        }
      }
    }

    return fresh;
  }

  async deleteServiceTariff(id: string) {
    const existing = await this.prisma.serviceTariff.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Service introuvable.');

    const linked = await this.prisma.enrollmentServiceSubscription.count({
      where: { serviceTariffId: id },
    });
    if (linked > 0) {
      throw new BadRequestException('Impossible de supprimer un service avec des abonnements.');
    }

    await this.prisma.serviceTariff.delete({ where: { id } });
    return { ok: true };
  }

  private async resolveSchoolYearForServices(): Promise<string> {
    const active = await this.prisma.schoolYear.findFirst({
      where: { status: SchoolYearStatus.OPEN },
      orderBy: { startDate: 'desc' },
    });
    return active?.label ?? '';
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

    const variantId =
      body?.variantId === undefined || body?.variantId === null || body?.variantId === ''
        ? null
        : String(body.variantId).trim();

    const existing = await this.prisma.serviceLevelPrice.findFirst({
      where: { schoolYear, levelId, serviceTariffId, variantId },
    });
    if (existing) {
      return this.prisma.serviceLevelPrice.update({
        where: { id: existing.id },
        data: { monthlyAmountCents },
        include: { serviceTariff: true, level: true, variant: true },
      });
    }
    return this.prisma.serviceLevelPrice.create({
      data: { schoolYear, levelId, serviceTariffId, variantId, monthlyAmountCents },
      include: { serviceTariff: true, level: true, variant: true },
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
