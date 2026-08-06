import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Put,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AppModuleRole } from '@prisma/client';
import { randomBytes } from 'crypto';
import type { Request } from 'express';
import { mkdirSync } from 'fs';
import { diskStorage } from 'multer';
import { extname, join } from 'path';
import { AdminJwtGuard } from '../auth/admin-jwt.guard';
import { AdminMustChangePasswordGuard } from '../auth/admin-must-change-password.guard';
import { AdminPermissionGuard } from '../auth/admin-permission.guard';
import { RequireAppModule } from '../auth/require-app-module.decorator';
import { AdminLandingService } from './admin-landing.service';

@Controller('admin/landing')
@UseGuards(AdminJwtGuard, AdminMustChangePasswordGuard, AdminPermissionGuard)
@RequireAppModule(AppModuleRole.LANDING)
export class AdminLandingController {
  constructor(private readonly landing: AdminLandingService) {}

  @Get()
  get() {
    return this.landing.getContent();
  }

  @Put()
  update(@Body() body: Record<string, unknown>) {
    return this.landing.updateContent(body ?? {});
  }

  @Post('reset')
  reset() {
    return this.landing.resetToDefaults();
  }

  @Post('upload')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: (_req, _file, cb) => {
          const dir = join(process.cwd(), 'uploads', 'landing');
          mkdirSync(dir, { recursive: true });
          cb(null, dir);
        },
        filename: (_req, file, cb) => {
          const ext = extname(file.originalname) || '.jpg';
          cb(null, `${Date.now()}-${randomBytes(8).toString('hex')}${ext.toLowerCase()}`);
        },
      }),
      limits: { fileSize: 3 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => {
        const ok = /\.(png|jpe?g|webp)$/i.test(file.originalname);
        cb(null, ok);
      },
    }),
  )
  upload(@UploadedFile() file: Express.Multer.File, @Req() req: Request) {
    if (!file) throw new BadRequestException('Image requise (PNG, JPG ou WEBP, max 3 Mo).');
    const publicPath = `/uploads/landing/${file.filename}`;
    const proto = req.get('x-forwarded-proto') ?? req.protocol;
    const host = req.get('host');
    const url = host ? `${proto}://${host}${publicPath}` : publicPath;
    return { url, path: publicPath, filename: file.originalname };
  }
}
