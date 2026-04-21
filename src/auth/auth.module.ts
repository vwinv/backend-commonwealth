import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AdminJwtGuard } from './admin-jwt.guard';
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
  providers: [AuthService, ParentJwtGuard, AdminJwtGuard],
  exports: [AuthService, JwtModule, ParentJwtGuard, AdminJwtGuard],
})
export class AuthModule {}
