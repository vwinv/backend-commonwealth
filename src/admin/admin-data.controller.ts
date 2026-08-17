import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { AdminJwtGuard, type AdminJwtPayload } from '../auth/admin-jwt.guard';
import { AdminMustChangePasswordGuard } from '../auth/admin-must-change-password.guard';
import { AdminDataService } from './admin-data.service';

@Controller('admin/data')
@UseGuards(AdminJwtGuard, AdminMustChangePasswordGuard)
export class AdminDataController {
  constructor(private readonly data: AdminDataService) {}

  @Get('tables')
  tables(@Req() req: Request & { adminUser?: AdminJwtPayload }) {
    return this.data.listTables(req.adminUser!.role);
  }

  @Post('wipe')
  wipe(@Body() body: Record<string, unknown>, @Req() req: Request & { adminUser?: AdminJwtPayload }) {
    const actor = req.adminUser!;
    return this.data.wipe(actor.role, actor.sub, body ?? {});
  }
}
