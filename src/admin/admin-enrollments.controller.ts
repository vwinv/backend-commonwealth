import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { AppModuleRole } from '@prisma/client';
import type { Request } from 'express';
import { AdminJwtGuard, type AdminJwtPayload } from '../auth/admin-jwt.guard';
import { AdminPermissionGuard } from '../auth/admin-permission.guard';
import { AdminMustChangePasswordGuard } from '../auth/admin-must-change-password.guard';
import { RequireAppModule } from '../auth/require-app-module.decorator';
import { BillingService } from '../billing/billing.service';
import { EnrollmentsService } from '../enrollments/enrollments.service';
import { AdminEnrollmentsService } from './admin-enrollments.service';

type AdminRequest = Request & { adminUser?: AdminJwtPayload };

@Controller('admin/enrollments')
@UseGuards(AdminJwtGuard, AdminMustChangePasswordGuard, AdminPermissionGuard)
@RequireAppModule(AppModuleRole.INSCRIPTIONS)
export class AdminEnrollmentsController {
  constructor(
    private readonly adminEnrollments: AdminEnrollmentsService,
    private readonly enrollmentsCore: EnrollmentsService,
    private readonly billing: BillingService,
  ) {}

  @Get()
  overview(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @Query('sort') sort?: string,
  ) {
    return this.adminEnrollments.getOverview({
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      search: search || undefined,
      sort: sort || undefined,
    });
  }

  @Get(':id')
  detail(@Param('id') id: string) {
    return this.adminEnrollments.getOneWithStats(id);
  }

  @Patch(':id/approve')
  approve(@Param('id') id: string, @Req() req: AdminRequest, @Body() body: Record<string, unknown>) {
    const validatedById = req.adminUser?.sub;
    if (!validatedById) throw new UnauthorizedException();
    return this.enrollmentsCore.approve(id, { ...body, validatedById });
  }

  /** Correction d’un dossier encore PENDING — notifie le parent (e-mail éditable). */
  @Patch(':id')
  updatePending(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.adminEnrollments.updatePendingDossier(id, body ?? {});
  }

  @Patch(':id/reject')
  reject(@Param('id') id: string, @Req() req: AdminRequest, @Body() body: Record<string, unknown>) {
    const validatedById = req.adminUser?.sub;
    if (!validatedById) throw new UnauthorizedException();
    return this.enrollmentsCore.reject(id, { ...body, validatedById });
  }

  /** Supprime factures non payées et régénère scolarité + mensualités selon le paramétrage actuel. */
  @Post(':id/billing/regenerate')
  regenerateBilling(@Param('id') id: string) {
    return this.billing.resetPendingBillingAndRegenerate(id);
  }
}
