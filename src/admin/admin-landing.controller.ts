import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Put,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AppModuleRole } from '@prisma/client';
import { AdminJwtGuard } from '../auth/admin-jwt.guard';
import { AdminMustChangePasswordGuard } from '../auth/admin-must-change-password.guard';
import { AdminPermissionGuard } from '../auth/admin-permission.guard';
import { RequireAppModule } from '../auth/require-app-module.decorator';
import { CLOUDINARY_FOLDERS } from '../cloudinary/cloudinary.folders';
import { CloudinaryService } from '../cloudinary/cloudinary.service';
import { IMAGE_FILENAME, memoryUploadOptions } from '../cloudinary/memory-upload';
import { AdminLandingService } from './admin-landing.service';

@Controller('admin/landing')
@UseGuards(AdminJwtGuard, AdminMustChangePasswordGuard, AdminPermissionGuard)
@RequireAppModule(AppModuleRole.LANDING)
export class AdminLandingController {
  constructor(
    private readonly landing: AdminLandingService,
    private readonly cloudinary: CloudinaryService,
  ) {}

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
    FileInterceptor(
      'file',
      memoryUploadOptions({ maxBytes: 3 * 1024 * 1024, filenamePattern: IMAGE_FILENAME }),
    ),
  )
  async upload(@UploadedFile() file: Express.Multer.File) {
    const uploaded = await this.cloudinary.uploadMulterFile(file, CLOUDINARY_FOLDERS.landingpage, {
      missingMessage: 'Image requise (PNG, JPG ou WEBP, max 3 Mo).',
    });
    return { url: uploaded.url, path: uploaded.url, filename: file.originalname };
  }
}
