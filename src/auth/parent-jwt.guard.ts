import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import type { UserRole } from '@prisma/client';

export type ParentJwtPayload = {
  sub: string;
  email: string;
  role: UserRole;
};

@Injectable()
export class ParentJwtGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request & { parentUser?: ParentJwtPayload }>();
    const token = this.extractToken(request);
    if (!token) throw new UnauthorizedException();
    try {
      const payload = this.jwtService.verify<ParentJwtPayload>(token);
      if (payload.role !== 'PARENT') throw new UnauthorizedException();
      request.parentUser = payload;
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
