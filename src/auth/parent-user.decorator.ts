import { createParamDecorator, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import type { ParentJwtPayload } from './parent-jwt.guard';

export const ParentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): ParentJwtPayload => {
    const request = ctx.switchToHttp().getRequest<Request & { parentUser?: ParentJwtPayload }>();
    const user = request.parentUser;
    if (!user) {
      throw new UnauthorizedException();
    }
    return user;
  },
);
