import { Controller, Get, UseGuards } from '@nestjs/common';
import { AdminJwtGuard } from '../auth/admin-jwt.guard';
import { AdminHomeAccessGuard } from '../auth/admin-home-access.guard';
import { AdminPermissionGuard } from '../auth/admin-permission.guard';
import { AdminMustChangePasswordGuard } from '../auth/admin-must-change-password.guard';
import { AdminDashboardService } from './admin-dashboard.service';

@Controller('admin')
@UseGuards(AdminJwtGuard, AdminMustChangePasswordGuard, AdminHomeAccessGuard, AdminPermissionGuard)
export class AdminDashboardController {
  constructor(private readonly dashboard: AdminDashboardService) {}

  @Get('dashboard')
  getDashboard() {
    return this.dashboard.getDashboard();
  }
}
