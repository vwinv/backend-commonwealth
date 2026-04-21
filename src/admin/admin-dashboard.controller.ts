import { Controller, Get, UseGuards } from '@nestjs/common';
import { AdminJwtGuard } from '../auth/admin-jwt.guard';
import { AdminDashboardService } from './admin-dashboard.service';

@Controller('admin')
@UseGuards(AdminJwtGuard)
export class AdminDashboardController {
  constructor(private readonly dashboard: AdminDashboardService) {}

  @Get('dashboard')
  getDashboard() {
    return this.dashboard.getDashboard();
  }
}
