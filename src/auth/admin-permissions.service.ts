import { Injectable } from '@nestjs/common';
import { AppModuleRole, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  ALL_APP_MODULE_ROLES,
  canAccessHome as userCanAccessHome,
  isSuperAdmin,
} from './app-module-roles';

@Injectable()
export class AdminPermissionsService {
  constructor(private readonly prisma: PrismaService) {}

  async getModuleRolesForUser(userId: string): Promise<AppModuleRole[]> {
    const rows = await this.prisma.userAppModuleRole.findMany({
      where: { userId },
      select: { role: true },
    });
    return rows.map((r) => r.role);
  }

  async getPermissionsForLogin(userId: string, systemRole: UserRole): Promise<AppModuleRole[]> {
    if (isSuperAdmin(systemRole)) {
      return [...ALL_APP_MODULE_ROLES];
    }
    return this.getModuleRolesForUser(userId);
  }

  hasModule(systemRole: UserRole, permissions: AppModuleRole[], required: AppModuleRole): boolean {
    if (isSuperAdmin(systemRole)) return true;
    return permissions.includes(required);
  }

  hasAnyModule(
    systemRole: UserRole,
    permissions: AppModuleRole[],
    required: AppModuleRole[],
  ): boolean {
    if (isSuperAdmin(systemRole)) return true;
    return required.some((r) => permissions.includes(r));
  }

  canAccessHome(systemRole: UserRole, jobTitle: string | null | undefined): boolean {
    return userCanAccessHome(systemRole, jobTitle);
  }

  async syncUserModuleRoles(userId: string, roles: AppModuleRole[]) {
    const unique = [...new Set(roles)];
    await this.prisma.$transaction([
      this.prisma.userAppModuleRole.deleteMany({ where: { userId } }),
      ...(unique.length > 0
        ? [
            this.prisma.userAppModuleRole.createMany({
              data: unique.map((role) => ({ userId, role })),
            }),
          ]
        : []),
    ]);
    return unique;
  }
}
