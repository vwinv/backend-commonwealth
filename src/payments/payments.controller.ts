import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { AppModuleRole } from '@prisma/client';
import { AdminJwtGuard } from '../auth/admin-jwt.guard';
import { AdminMustChangePasswordGuard } from '../auth/admin-must-change-password.guard';
import { AdminPermissionGuard } from '../auth/admin-permission.guard';
import { RequireAppModule } from '../auth/require-app-module.decorator';
import { PaymentsService } from './payments.service';

@Controller('backoffice')
@UseGuards(AdminJwtGuard, AdminMustChangePasswordGuard, AdminPermissionGuard)
@RequireAppModule(AppModuleRole.FINANCE)
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post('payments')
  recordPayment(@Body() body: Record<string, unknown>) {
    return this.payments.recordPayment(body);
  }

  @Get('enrollments/:enrollmentId/payments')
  listEnrollmentPayments(@Param('enrollmentId') enrollmentId: string) {
    return this.payments.listEnrollmentPayments(enrollmentId);
  }
}
