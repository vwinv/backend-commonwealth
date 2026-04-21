import { BadRequestException, Body, Controller, Get, Post, Put, Query } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Controller('backoffice/pricing')
export class PricingController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('service-tariffs')
  listServiceTariffs() {
    return this.prisma.serviceTariff.findMany({ orderBy: { code: 'asc' } });
  }

  @Post('service-tariffs')
  async createServiceTariff(@Body() body: Record<string, unknown>) {
    const code = String(body?.code ?? '').trim().toUpperCase();
    const label = String(body?.label ?? '').trim();
    if (!code || !label) throw new BadRequestException('code and label are required');
    return this.prisma.serviceTariff.create({
      data: { code, label, active: body?.active !== false },
    });
  }

  @Get('level-prices')
  async listLevelPrices(@Query('schoolYear') schoolYear: string) {
    const sy = String(schoolYear ?? '').trim();
    if (!sy) throw new BadRequestException('schoolYear query is required');
    return this.prisma.levelSchoolYearPricing.findMany({
      where: { schoolYear: sy },
      include: { level: true },
      orderBy: { level: { order: 'asc' } },
    });
  }

  @Put('level-prices')
  async upsertLevelPrice(@Body() body: Record<string, unknown>) {
    const schoolYear = String(body?.schoolYear ?? '').trim();
    const levelId = String(body?.levelId ?? '').trim();
    const annualTuitionCents = Number(body?.annualTuitionCents);
    const monthlyBaseCents = Number(body?.monthlyBaseCents);
    if (!schoolYear || !levelId) throw new BadRequestException('schoolYear and levelId are required');
    if (!Number.isInteger(annualTuitionCents) || annualTuitionCents < 0) {
      throw new BadRequestException('annualTuitionCents must be a non-negative integer (centimes)');
    }
    if (!Number.isInteger(monthlyBaseCents) || monthlyBaseCents < 0) {
      throw new BadRequestException('monthlyBaseCents must be a non-negative integer (centimes)');
    }
    return this.prisma.levelSchoolYearPricing.upsert({
      where: { schoolYear_levelId: { schoolYear, levelId } },
      update: { annualTuitionCents, monthlyBaseCents },
      create: { schoolYear, levelId, annualTuitionCents, monthlyBaseCents },
      include: { level: true },
    });
  }

  @Get('service-prices')
  async listServicePrices(@Query('schoolYear') schoolYear: string, @Query('levelId') levelId: string) {
    const sy = String(schoolYear ?? '').trim();
    const lid = String(levelId ?? '').trim();
    if (!sy || !lid) throw new BadRequestException('schoolYear and levelId query params are required');
    return this.prisma.serviceLevelPrice.findMany({
      where: { schoolYear: sy, levelId: lid },
      include: { serviceTariff: true },
      orderBy: { serviceTariff: { code: 'asc' } },
    });
  }

  @Put('service-prices')
  async upsertServicePrice(@Body() body: Record<string, unknown>) {
    const schoolYear = String(body?.schoolYear ?? '').trim();
    const levelId = String(body?.levelId ?? '').trim();
    const serviceTariffId = String(body?.serviceTariffId ?? '').trim();
    const monthlyAmountCents = Number(body?.monthlyAmountCents);
    if (!schoolYear || !levelId || !serviceTariffId) {
      throw new BadRequestException('schoolYear, levelId and serviceTariffId are required');
    }
    if (!Number.isInteger(monthlyAmountCents) || monthlyAmountCents < 0) {
      throw new BadRequestException('monthlyAmountCents must be a non-negative integer (centimes)');
    }
    return this.prisma.serviceLevelPrice.upsert({
      where: {
        schoolYear_levelId_serviceTariffId: { schoolYear, levelId, serviceTariffId },
      },
      update: { monthlyAmountCents },
      create: { schoolYear, levelId, serviceTariffId, monthlyAmountCents },
      include: { serviceTariff: true, level: true },
    });
  }
}
