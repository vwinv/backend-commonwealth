import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { isAdminPortalRole } from './app-module-roles';
import type { AdminJwtPayload } from './parent-jwt.guard';

export type { AdminJwtPayload, ParentJwtPayload } from './parent-jwt.guard';

@Injectable()
export class AdminJwtGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<Request & { adminUser?: AdminJwtPayload }>();
    const token = this.extractToken(request);
    if (!token) throw new UnauthorizedException();
    try {
      const payload = this.jwtService.verify<AdminJwtPayload>(token);
      const role = payload.role;
      if (!isAdminPortalRole(role)) {
        throw new UnauthorizedException();
      }
      request.adminUser = payload;
      return true;
    } catch {
      throw new UnauthorizedException();
    }
  }

  private extractToken(request: Request): string | undefined {
    const auth = request.headers.authorization;
    if (auth?.startsWith('Bearer ')) return auth.slice(7).trim();
    return undefined;
  }
}
