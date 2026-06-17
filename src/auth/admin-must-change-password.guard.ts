import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { AdminJwtPayload } from './admin-jwt.guard';
import { SKIP_MUST_CHANGE_PASSWORD_KEY } from './skip-must-change-password.decorator';

@Injectable()
export class AdminMustChangePasswordGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_MUST_CHANGE_PASSWORD_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skip) return true;

    const request = context
      .switchToHttp()
      .getRequest<Request & { adminUser?: AdminJwtPayload }>();
    const admin = request.adminUser;
    if (!admin?.mustChangePassword) return true;

    throw new ForbiddenException({
      message: 'Vous devez changer votre mot de passe avant de continuer.',
      code: 'MUST_CHANGE_PASSWORD',
    });
  }
}
