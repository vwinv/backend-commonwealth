import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { OptionPricingMode, Prisma, SchoolYearStatus, ServiceBillingPeriod } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { getLevelCapacitySnapshot } from '../enrollments/class-capacity.util';

@Injectable()
export class CatalogService {
  constructor(private readonly prisma: PrismaService) {}

  listLevels() {
    return this.prisma.level.findMany({
      orderBy: [{ order: 'asc' }, { name: 'asc' }],
      include: { classes: true, documents: { include: { document: true } } },
    });
  }

  async listLevelsForEnrollment() {
    const openYear = await this.prisma.schoolYear.findFirst({
      where: { status: SchoolYearStatus.OPEN },
      orderBy: { startDate: 'desc' },
      select: { label: true },
    });
    const schoolYear = openYear?.label ?? null;

    const levels = await this.prisma.level.findMany({
      orderBy: [{ order: 'asc' }, { name: 'asc' }],
      include: {
        classes: { orderBy: { createdAt: 'asc' }, select: { id: true, name: true } },
      },
    });

    const results: Array<{
      id: string;
      name: string;
      order: number | null;
      classes: { id: string; name: string }[];
      enrollmentOpen: boolean;
      availableSpots: number;
      closedMessage: string | null;
    }> = [];
    for (const level of levels) {
      let enrollmentOpen = false;
      let availableSpots = 0;
      if (schoolYear && level.classes.length > 0) {
        const snapshot = await getLevelCapacitySnapshot(this.prisma, level.id, schoolYear);
        enrollmentOpen = snapshot.enrollmentOpen;
        availableSpots = snapshot.availableSpots;
      }

      results.push({
        id: level.id,
        name: level.name,
        order: level.order,
        classes: level.classes,
        enrollmentOpen,
        availableSpots,
        closedMessage: enrollmentOpen ? null : 'Les inscriptions sont fermées pour ce niveau.',
      });
    }

    return results;
  }

  async activeSchoolYear() {
    const row = await this.prisma.schoolYear.findFirst({
      where: { status: SchoolYearStatus.OPEN },
      orderBy: { startDate: 'desc' },
      select: { label: true, startDate: true, endDate: true },
    });
    return { active: row };
  }

  async createLevel(input: any) {
    const name = String(input?.name ?? '').trim();
    if (!name) throw new BadRequestException('name is required');
    const order = input?.order === undefined || input?.order === null ? undefined : Number(input.order);
    if (order !== undefined && !Number.isInteger(order)) throw new BadRequestException('order must be an integer');

    try {
      return await this.prisma.level.create({ data: { name, order } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new BadRequestException('Level name already exists');
      }
      throw e;
    }
  }

  async listClasses(levelId: string) {
    const level = await this.prisma.level.findUnique({ where: { id: levelId }, select: { id: true } });
    if (!level) throw new NotFoundException('Level not found');
    return this.prisma.classRoom.findMany({
      where: { levelId },
      orderBy: [{ name: 'asc' }],
    });
  }

  async listLevelSchedulesForEnrollment(levelId: string) {
    const lid = String(levelId ?? '').trim();
    if (!lid) throw new BadRequestException('levelId is required');

    const level = await this.prisma.level.findUnique({
      where: { id: lid },
      select: { id: true, name: true },
    });
    if (!level) throw new NotFoundException('Niveau introuvable.');

    const openYear = await this.prisma.schoolYear.findFirst({
      where: { status: SchoolYearStatus.OPEN },
      orderBy: { startDate: 'desc' },
      select: { label: true },
    });
    const schoolYear = openYear?.label ?? null;
    if (!schoolYear) {
      return { schoolYear: null, level, schedules: [] };
    }

    const schedules = await this.prisma.levelSchedule.findMany({
      where: { levelId: lid, schoolYear, active: true },
      orderBy: [{ order: 'asc' }, { label: 'asc' }],
    });

    return {
      schoolYear,
      level,
      schedules: schedules.map((s) => ({
        id: s.id,
        label: s.label,
        timeDescription: s.timeDescription ?? '',
        annualXof: s.annualTuitionCents / 100,
        monthlyXof: s.monthlyBaseCents / 100,
      })),
    };
  }

  async listServicesForEnrollment() {
    const items = await this.prisma.serviceTariff.findMany({
      where: { active: true },
      orderBy: [{ label: 'asc' }],
      include: {
        variants: {
          where: { active: true },
          orderBy: [{ order: 'asc' }, { label: 'asc' }],
        },
      },
    });

    return {
      items: items.map((s) => ({
        id: s.id,
        code: s.code,
        label: s.label,
        pricingMode: s.pricingMode,
        pricingModeLabel:
          s.pricingMode === OptionPricingMode.CUSTOMIZABLE ? 'Personnalisable' : 'Prix unique',
        amountXof: s.amountCents / 100,
        billingPeriod: s.billingPeriod,
        billingPeriodLabel: s.billingPeriod === ServiceBillingPeriod.YEARLY ? 'annuel' : 'mensuel',
        variants: s.variants.map((v) => ({
          id: v.id,
          code: v.code,
          label: v.label,
          amountXof: v.amountCents / 100,
          billingPeriod: v.billingPeriod,
          billingPeriodLabel: v.billingPeriod === ServiceBillingPeriod.YEARLY ? 'annuel' : 'mensuel',
        })),
      })),
    };
  }

  async createClass(input: any) {
    const levelId = String(input?.levelId ?? '').trim();
    const name = String(input?.name ?? '').trim();
    if (!levelId) throw new BadRequestException('levelId is required');
    if (!name) throw new BadRequestException('name is required');

    try {
      return await this.prisma.classRoom.create({ data: { levelId, name } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2003') {
        throw new NotFoundException('Level not found');
      }
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new BadRequestException('Class already exists for this level');
      }
      throw e;
    }
  }

  async createDocument(input: any) {
    const title = String(input?.title ?? '').trim();
    const url = String(input?.url ?? '').trim();
    if (!title) throw new BadRequestException('title is required');
    if (!url) throw new BadRequestException('url is required');

    return this.prisma.document.create({ data: { title, url } });
  }

  async attachDocument(levelId: string, documentId: string) {
    try {
      return await this.prisma.levelDocument.create({
        data: { levelId, documentId },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2003') {
        throw new NotFoundException('Level or Document not found');
      }
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new BadRequestException('Document already attached to this level');
      }
      throw e;
    }
  }
}

