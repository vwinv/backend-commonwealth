import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
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
import { AdminAteliersService } from './admin-ateliers.service';

@Controller('admin/ateliers')
@UseGuards(AdminJwtGuard, AdminMustChangePasswordGuard, AdminPermissionGuard)
@RequireAppModule(AppModuleRole.ATELIERS)
export class AdminAteliersController {
  constructor(
    private readonly ateliers: AdminAteliersService,
    private readonly cloudinary: CloudinaryService,
  ) {}

  @Get()
  overview(
    @Query('search') search?: string,
    @Query('sort') sort?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Query('tab') tab?: string,
  ) {
    return this.ateliers.getOverview({ search, sort, dateFrom, dateTo, tab });
  }

  @Post('upload')
  @UseInterceptors(
    FileInterceptor(
      'file',
      memoryUploadOptions({ maxBytes: 2 * 1024 * 1024, filenamePattern: IMAGE_FILENAME }),
    ),
  )
  async upload(@UploadedFile() file: Express.Multer.File) {
    const uploaded = await this.cloudinary.uploadMulterFile(file, CLOUDINARY_FOLDERS.ateliers, {
      missingMessage: 'Image requise (PNG, JPG ou WEBP, max 2 Mo).',
    });
    return { url: uploaded.url, path: uploaded.url, filename: file.originalname };
  }

  @Post()
  create(@Body() body: Record<string, unknown>) {
    return this.ateliers.create(body);
  }

  @Get(':id')
  getOne(@Param('id') id: string) {
    return this.ateliers.getById(id);
  }

  @Post(':id/duplicate')
  duplicate(@Param('id') id: string) {
    return this.ateliers.duplicate(id);
  }

  @Patch(':id/publish')
  setPublished(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.ateliers.setPublished(id, body);
  }

  @Patch(':id/close')
  setClosed(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.ateliers.setClosed(id, body);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.ateliers.update(id, body);
  }

  @Post('reservations')
  createReservation(@Body() body: Record<string, unknown>) {
    return this.ateliers.createReservation(body);
  }

  @Patch('reservations/:id')
  updateReservation(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.ateliers.updateReservationStatus(id, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  remove(@Param('id') id: string) {
    return this.ateliers.remove(id);
  }
}
