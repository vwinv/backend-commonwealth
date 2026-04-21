import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UserRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import type { ParentJwtPayload } from './parent-jwt.guard';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
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
    if (
      !user ||
      (user.role !== UserRole.ADMIN && user.role !== UserRole.STAFF) ||
      !user.passwordHash
    ) {
      throw new UnauthorizedException('Identifiants incorrects');
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      throw new UnauthorizedException('Identifiants incorrects');
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
        role: user.role,
      },
    };
  }
}
