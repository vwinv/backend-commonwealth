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
import { AdminPermissionGuard } from '../auth/admin-permission.guard';
import { AdminMustChangePasswordGuard } from '../auth/admin-must-change-password.guard';
import { RequireAppModule } from '../auth/require-app-module.decorator';
import { CLOUDINARY_FOLDERS } from '../cloudinary/cloudinary.folders';
import { CloudinaryService } from '../cloudinary/cloudinary.service';
import { DOCUMENT_FILENAME, memoryUploadOptions } from '../cloudinary/memory-upload';
import { AdminDocumentsService } from './admin-documents.service';

@Controller('admin/documents')
@UseGuards(AdminJwtGuard, AdminMustChangePasswordGuard, AdminPermissionGuard)
@RequireAppModule(AppModuleRole.DOCUMENTS)
export class AdminDocumentsController {
  constructor(
    private readonly documents: AdminDocumentsService,
    private readonly cloudinary: CloudinaryService,
  ) {}

  @Get()
  overview(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @Query('sort') sort?: string,
  ) {
    return this.documents.getOverview({
      page: page !== undefined && page !== '' ? parseInt(page, 10) : undefined,
      limit: limit !== undefined && limit !== '' ? parseInt(limit, 10) : undefined,
      search: search || undefined,
      sort: sort || undefined,
    });
  }

  @Get('parent-options')
  parentOptions(@Query('search') search?: string) {
    return this.documents.searchParentOptions(search || undefined);
  }

  @Get('audience-options')
  audienceOptions() {
    return this.documents.getAudienceOptions();
  }

  @Post('upload')
  @UseInterceptors(
    FileInterceptor(
      'file',
      memoryUploadOptions({ maxBytes: 20 * 1024 * 1024, filenamePattern: DOCUMENT_FILENAME }),
    ),
  )
  async upload(@UploadedFile() file: Express.Multer.File) {
    const uploaded = await this.cloudinary.uploadMulterFile(file, CLOUDINARY_FOLDERS.documents, {
      resourceType: 'raw',
      missingMessage: 'Fichier requis (PDF, DOC ou DOCX).',
    });
    return { url: uploaded.url, path: uploaded.url, filename: file.originalname };
  }

  @Post()
  create(@Body() body: Record<string, unknown>) {
    return this.documents.create(body);
  }

  @Get(':id/signatures')
  signatures(
    @Param('id') id: string,
    @Query('status') status?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.documents.getSignatures(id, {
      status: status || undefined,
      search: search || undefined,
      page: page !== undefined && page !== '' ? parseInt(page, 10) : undefined,
      limit: limit !== undefined && limit !== '' ? parseInt(limit, 10) : undefined,
    });
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.documents.updatePublished(id, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  remove(@Param('id') id: string) {
    return this.documents.remove(id);
  }
}
