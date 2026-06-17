import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AppModuleRole } from '@prisma/client';
import type { Request } from 'express';
import { AdminPermissionsService } from './admin-permissions.service';
import type { AdminJwtPayload } from './admin-jwt.guard';
import { REQUIRE_APP_MODULE_KEY } from './require-app-module.decorator';

@Injectable()
export class AdminPermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly permissions: AdminPermissionsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<AppModuleRole[] | undefined>(
      REQUIRE_APP_MODULE_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required?.length) return true;

    const request = context
      .switchToHttp()
      .getRequest<Request & { adminUser?: AdminJwtPayload }>();
    const admin = request.adminUser;
    if (!admin) throw new ForbiddenException('Accès refusé.');

    let perms = admin.permissions;
    if (!perms) {
      perms = await this.permissions.getPermissionsForLogin(admin.sub, admin.role);
      admin.permissions = perms;
    }

    const ok = this.permissions.hasAnyModule(admin.role, perms, required);
    if (!ok) {
      throw new ForbiddenException('Vous n’avez pas accès à ce module.');
    }
    return true;
  }
}
