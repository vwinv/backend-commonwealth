import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AdminJwtGuard } from './admin-jwt.guard';
import { AdminMustChangePasswordGuard } from './admin-must-change-password.guard';
import { AdminHomeAccessGuard } from './admin-home-access.guard';
import { AdminPermissionGuard } from './admin-permission.guard';
import { AdminPermissionsService } from './admin-permissions.service';
import { ParentJwtGuard } from './parent-jwt.guard';

@Module({
  imports: [
    PrismaModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => ({
        secret:
          config.get<string>('JWT_SECRET')?.trim() ||
          'dev-only-change-JWT_SECRET-in-production',
        signOptions: {
          expiresIn: 60 * 60 * 24 * 7,
        },
      }),
      inject: [ConfigService],
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, ParentJwtGuard, AdminJwtGuard, AdminMustChangePasswordGuard, AdminHomeAccessGuard, AdminPermissionGuard, AdminPermissionsService],
  exports: [AuthService, JwtModule, ParentJwtGuard, AdminJwtGuard, AdminMustChangePasswordGuard, AdminHomeAccessGuard, AdminPermissionGuard, AdminPermissionsService],
})
export class AuthModule {}
