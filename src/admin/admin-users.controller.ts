import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AppModuleRole } from '@prisma/client';
import type { Request } from 'express';
import type { UserRole } from '@prisma/client';
import { AdminJwtGuard, type AdminJwtPayload } from '../auth/admin-jwt.guard';
import { AdminPermissionGuard } from '../auth/admin-permission.guard';
import { AdminMustChangePasswordGuard } from '../auth/admin-must-change-password.guard';
import { RequireAppModule } from '../auth/require-app-module.decorator';
import { AdminUsersService } from './admin-users.service';

@Controller('admin/users')
@UseGuards(AdminJwtGuard, AdminMustChangePasswordGuard, AdminPermissionGuard)
@RequireAppModule(AppModuleRole.UTILISATEURS)
export class AdminUsersController {
  constructor(private readonly users: AdminUsersService) {}

  @Get('role-options')
  roleOptions() {
    return this.users.listRoleOptions();
  }

  @Post()
  create(@Body() body: Record<string, unknown>, @Req() req: Request & { adminUser?: AdminJwtPayload }) {
    const actor = req.adminUser!;
    return this.users.create(actor.role as UserRole, body);
  }

  @Get()
  overview(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @Query('sort') sort?: string,
  ) {
    return this.users.getOverview({
      page: page !== undefined && page !== '' ? parseInt(page, 10) : undefined,
      limit: limit !== undefined && limit !== '' ? parseInt(limit, 10) : undefined,
      search: search || undefined,
      sort: sort || undefined,
    });
  }

  @Patch(':id')
  patch(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @Req() req: Request & { adminUser?: AdminJwtPayload },
  ) {
    const actor = req.adminUser!;
    return this.users.update(actor.sub, actor.role as UserRole, id, body);
  }

  @Post(':id/reset-password')
  resetPassword(@Param('id') id: string, @Req() req: Request & { adminUser?: AdminJwtPayload }) {
    const actor = req.adminUser!;
    return this.users.resetPassword(actor.sub, actor.role as UserRole, id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id') id: string, @Req() req: Request & { adminUser?: AdminJwtPayload }) {
    const actor = req.adminUser!;
    await this.users.remove(actor.sub, actor.role as UserRole, id);
  }
}
