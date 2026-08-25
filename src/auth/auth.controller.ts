import { Body, Controller, Get, Patch, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { AuthService } from './auth.service';
import { AdminJwtGuard, type AdminJwtPayload } from './admin-jwt.guard';
import { SkipMustChangePassword } from './skip-must-change-password.decorator';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('parent/login')
  parentLogin(@Body() body: { email?: string; password?: string }) {
    return this.auth.parentLogin(body);
  }

  @Post('parent/forgot-password')
  parentForgotPassword(@Body() body: { email?: string }) {
    return this.auth.parentForgotPassword(body);
  }

  @Post('admin/login')
  adminLogin(@Body() body: { email?: string; password?: string }) {
    return this.auth.adminLogin(body);
  }

  @Get('admin/me')
  @UseGuards(AdminJwtGuard)
  @SkipMustChangePassword()
  adminMe(@Req() req: Request & { adminUser?: AdminJwtPayload }) {
    return this.auth.adminSession(req.adminUser!.sub);
  }

  @Patch('admin/me/password')
  @UseGuards(AdminJwtGuard)
  @SkipMustChangePassword()
  adminChangePassword(
    @Req() req: Request & { adminUser?: AdminJwtPayload },
    @Body() body: Record<string, unknown>,
  ) {
    return this.auth.adminChangePassword(req.adminUser!.sub, body);
  }
}
