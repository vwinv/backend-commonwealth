import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { AppModuleRole } from '@prisma/client';
import { AdminJwtGuard } from '../auth/admin-jwt.guard';
import { AdminPermissionGuard } from '../auth/admin-permission.guard';
import { AdminMustChangePasswordGuard } from '../auth/admin-must-change-password.guard';
import { RequireAppModule } from '../auth/require-app-module.decorator';
import { AdminSettingsService } from './admin-settings.service';

@Controller('admin/settings')
@UseGuards(AdminJwtGuard, AdminMustChangePasswordGuard, AdminPermissionGuard)
@RequireAppModule(AppModuleRole.PARAMETRAGE)
export class AdminSettingsController {
  constructor(private readonly settings: AdminSettingsService) {}

  @Get('school-years')
  listSchoolYears() {
    return this.settings.listSchoolYears();
  }

  @Get('school-years/active')
  activeSchoolYear() {
    return this.settings.getActiveSchoolYear();
  }

  @Post('school-years')
  createSchoolYear(@Body() body: Record<string, unknown>) {
    return this.settings.createSchoolYear(body);
  }

  @Patch('school-years/:id/close')
  closeSchoolYear(@Param('id') id: string) {
    return this.settings.closeSchoolYear(id);
  }

  @Patch('school-years/:id/open')
  openSchoolYear(@Param('id') id: string) {
    return this.settings.openSchoolYear(id);
  }

  @Get('school-years/:id/deletion-impact')
  schoolYearDeletionImpact(@Param('id') id: string) {
    return this.settings.getSchoolYearDeletionImpact(id);
  }

  @Delete('school-years/:id')
  deleteSchoolYear(@Param('id') id: string) {
    return this.settings.deleteSchoolYear(id);
  }

  /** Niveaux seuls (ordre d’affichage), sans exiger une année scolaire ouverte. */
  @Get('levels')
  listLevelsForSelect() {
    return this.settings.listLevelsForSelect();
  }

  /** Niveaux, classes et tarifs (inscription + mensualité) pour une année scolaire. */
  @Get('catalog')
  getCatalog(@Query('schoolYear') schoolYear?: string) {
    return this.settings.getCatalog(schoolYear);
  }

  /** Crée un niveau et le barème pour l’année scolaire indiquée. */
  @Post('levels')
  createLevel(@Body() body: Record<string, unknown>) {
    return this.settings.createLevel(body);
  }

  /** Crée ou met à jour le barème d’un niveau pour une année scolaire. */
  @Put('levels/:levelId/pricing')
  upsertPricing(
    @Param('levelId') levelId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.settings.upsertLevelPricing(levelId, body);
  }

  /** Réactualise les factures non payées des inscriptions validées pour ce niveau + année. */
  @Post('levels/:levelId/pricing/regenerate')
  regeneratePricingPendingInvoices(
    @Param('levelId') levelId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.settings.regeneratePendingInvoicesForLevelPricing(levelId, body);
  }

  @Post('classes')
  createClass(@Body() body: Record<string, unknown>) {
    return this.settings.createClass(body);
  }

  @Patch('classes/:id')
  updateClass(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.settings.updateClass(id, body);
  }

  @Delete('classes/:id')
  deleteClass(@Param('id') id: string) {
    return this.settings.deleteClass(id);
  }

  @Put('levels/:levelId/schedules')
  replaceLevelSchedules(@Param('levelId') levelId: string, @Body() body: Record<string, unknown>) {
    return this.settings.replaceLevelSchedules(levelId, body);
  }

  @Patch('levels/:levelId')
  updateLevel(@Param('levelId') levelId: string, @Body() body: Record<string, unknown>) {
    return this.settings.updateLevel(levelId, body);
  }

  @Delete('levels/:levelId')
  deleteLevel(@Param('levelId') levelId: string) {
    return this.settings.deleteLevel(levelId);
  }

  @Get('levels/:levelId/schedules')
  getLevelSchedules(@Param('levelId') levelId: string, @Query('schoolYear') schoolYear?: string) {
    return this.settings.getLevelSchedules(levelId, String(schoolYear ?? ''));
  }

  @Get('services')
  listServices(@Query('schoolYear') schoolYear?: string) {
    return this.settings.listServiceTariffs(schoolYear);
  }

  @Post('services')
  createService(@Body() body: Record<string, unknown>) {
    return this.settings.createServiceTariff(body);
  }

  @Patch('services/:id')
  updateService(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.settings.updateServiceTariff(id, body);
  }

  @Delete('services/:id')
  deleteService(@Param('id') id: string) {
    return this.settings.deleteServiceTariff(id);
  }

  @Get('service-prices')
  listServicePrices(
    @Query('schoolYear') schoolYear?: string,
    @Query('levelId') levelId?: string,
  ) {
    return this.settings.listServicePrices(String(schoolYear ?? ''), String(levelId ?? ''));
  }

  @Put('service-prices')
  upsertServicePrice(@Body() body: Record<string, unknown>) {
    return this.settings.upsertServicePrice(body);
  }

  @Post('service-prices/regenerate')
  regenerateServicePriceInvoices(@Body() body: Record<string, unknown>) {
    return this.settings.regeneratePendingInvoicesForServicePrice(body);
  }
}
