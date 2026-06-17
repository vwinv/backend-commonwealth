import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import { AdminPermissionsService } from './admin-permissions.service';
import type { AdminJwtPayload } from './admin-jwt.guard';

@Injectable()
export class AdminHomeAccessGuard implements CanActivate {
  constructor(private readonly permissions: AdminPermissionsService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<Request & { adminUser?: AdminJwtPayload }>();
    const admin = request.adminUser;
    if (!admin) throw new ForbiddenException('Accès refusé.');

    if (!this.permissions.canAccessHome(admin.role, admin.jobTitle)) {
      throw new ForbiddenException(
        'Le tableau de bord est réservé à l’administrateur et au directeur.',
      );
    }
    return true;
  }
}
