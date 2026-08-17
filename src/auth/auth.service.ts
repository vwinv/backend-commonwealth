import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UserRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { AdminPermissionsService } from './admin-permissions.service';
import { isAdminPortalRole, isSuperAdmin, roleOptionsForApi } from './app-module-roles';
import type { AdminJwtPayload, ParentJwtPayload } from './parent-jwt.guard';

const BCRYPT_ROUNDS = 10;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly adminPermissions: AdminPermissionsService,
  ) {}

  async parentLogin(body: { email?: string; password?: string }) {
    const email = String(body?.email ?? '').trim().toLowerCase();
    const password = String(body?.password ?? '');
    if (!email || !password) {
      throw new BadRequestException('Email et mot de passe requis');
    }

    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || user.role !== UserRole.PARENT || !user.passwordHash) {
      throw new UnauthorizedException('Identifiants incorrects');
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      throw new UnauthorizedException('Identifiants incorrects');
    }
    if (user.blocked) {
      throw new UnauthorizedException('Compte désactivé');
    }

    const payload: ParentJwtPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
    };
    const accessToken = await this.jwtService.signAsync(payload);

    return {
      accessToken,
      user: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        phone: user.phone,
      },
    };
  }

  async adminLogin(body: { email?: string; password?: string }) {
    const email = String(body?.email ?? '').trim().toLowerCase();
    const password = String(body?.password ?? '');
    if (!email || !password) {
      throw new BadRequestException('Email et mot de passe requis');
    }

    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || !isAdminPortalRole(user.role) || !user.passwordHash) {
      throw new UnauthorizedException('Identifiants incorrects');
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      throw new UnauthorizedException('Identifiants incorrects');
    }
    if (user.blocked) {
      throw new UnauthorizedException('Compte désactivé');
    }

    const permissions = await this.adminPermissions.getPermissionsForLogin(user.id, user.role);
    const mustChangePassword = user.mustChangePassword;
    const payload: AdminJwtPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      permissions,
      mustChangePassword,
      jobTitle: user.jobTitle?.trim() || null,
    };
    const accessToken = await this.jwtService.signAsync(payload);

    return {
      accessToken,
      mustChangePassword,
      user: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        role: user.role,
        isSuperAdmin: isSuperAdmin(user.role),
        permissions,
      },
      roleOptions: roleOptionsForApi(),
    };
  }

  async adminSession(adminUserId: string) {
    const user = await this.prisma.user.findFirst({
      where: {
        id: adminUserId,
        role: { in: [UserRole.ADMIN, UserRole.STAFF] },
      },
      select: {
        id: true,
        email: true,
        fullName: true,
        role: true,
        jobTitle: true,
        blocked: true,
        mustChangePassword: true,
      },
    });
    if (!user || user.blocked) {
      throw new UnauthorizedException('Session invalide');
    }
    const permissions = await this.adminPermissions.getPermissionsForLogin(user.id, user.role);
    return {
      user: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        role: user.role,
        jobTitle: user.jobTitle,
        isSuperAdmin: isSuperAdmin(user.role),
        permissions,
        mustChangePassword: user.mustChangePassword,
      },
      roleOptions: roleOptionsForApi(),
    };
  }

  async adminChangePassword(adminUserId: string, body: Record<string, unknown>) {
    const newPassword = String(body?.newPassword ?? '');
    const currentPassword = String(body?.currentPassword ?? '');

    if (!newPassword || newPassword.length < 8) {
      throw new BadRequestException('Le nouveau mot de passe doit contenir au moins 8 caractères.');
    }

    const user = await this.prisma.user.findFirst({
      where: {
        id: adminUserId,
        role: { in: [UserRole.ADMIN, UserRole.STAFF] },
      },
    });
    if (!user || !user.passwordHash) {
      throw new UnauthorizedException('Session invalide');
    }
    if (user.blocked) {
      throw new UnauthorizedException('Compte désactivé');
    }

    if (!user.mustChangePassword) {
      if (!currentPassword) {
        throw new BadRequestException('Le mot de passe actuel est requis.');
      }
      const ok = await bcrypt.compare(currentPassword, user.passwordHash);
      if (!ok) {
        throw new BadRequestException('Mot de passe actuel incorrect.');
      }
    }

    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    const updated = await this.prisma.user.update({
      where: { id: adminUserId },
      data: { passwordHash, mustChangePassword: false },
      select: {
        id: true,
        email: true,
        fullName: true,
        role: true,
        jobTitle: true,
        mustChangePassword: true,
      },
    });

    const permissions = await this.adminPermissions.getPermissionsForLogin(
      updated.id,
      updated.role,
    );
    const payload: AdminJwtPayload = {
      sub: updated.id,
      email: updated.email,
      role: updated.role,
      permissions,
      mustChangePassword: false,
      jobTitle: updated.jobTitle?.trim() || null,
    };
    const accessToken = await this.jwtService.signAsync(payload);

    return {
      accessToken,
      mustChangePassword: false,
      user: {
        id: updated.id,
        email: updated.email,
        fullName: updated.fullName,
        role: updated.role,
        isSuperAdmin: isSuperAdmin(updated.role),
        permissions,
      },
    };
  }
}
