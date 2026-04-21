import { Body, Controller, Post } from '@nestjs/common';
import { AuthService } from './auth.service';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('parent/login')
  parentLogin(@Body() body: { email?: string; password?: string }) {
    return this.auth.parentLogin(body);
  }

  @Post('admin/login')
  adminLogin(@Body() body: { email?: string; password?: string }) {
    return this.auth.adminLogin(body);
  }
}
