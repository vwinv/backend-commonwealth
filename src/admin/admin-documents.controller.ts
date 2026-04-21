import {
  BadRequestException,
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
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { randomBytes } from 'crypto';
import type { Request } from 'express';
import { mkdirSync } from 'fs';
import { diskStorage } from 'multer';
import { extname, join } from 'path';
import { AdminJwtGuard } from '../auth/admin-jwt.guard';
import { AdminDocumentsService } from './admin-documents.service';

@Controller('admin/documents')
@UseGuards(AdminJwtGuard)
export class AdminDocumentsController {
  constructor(private readonly documents: AdminDocumentsService) {}

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

  @Post('upload')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: (_req, _file, cb) => {
          const dir = join(process.cwd(), 'uploads', 'documents');
          mkdirSync(dir, { recursive: true });
          cb(null, dir);
        },
        filename: (_req, file, cb) => {
          const ext = extname(file.originalname) || '.bin';
          cb(null, `${Date.now()}-${randomBytes(8).toString('hex')}${ext.toLowerCase()}`);
        },
      }),
      limits: { fileSize: 20 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => {
        const ok = /\.(pdf|doc|docx)$/i.test(file.originalname);
        cb(null, ok);
      },
    }),
  )
  upload(@UploadedFile() file: Express.Multer.File, @Req() req: Request) {
    if (!file) {
      throw new BadRequestException('Fichier requis (PDF, DOC ou DOCX).');
    }
    const publicPath = `/uploads/documents/${file.filename}`;
    const proto = req.get('x-forwarded-proto') ?? req.protocol;
    const host = req.get('host');
    const url = host ? `${proto}://${host}${publicPath}` : publicPath;
    return { url, path: publicPath, filename: file.originalname };
  }

  @Post()
  create(@Body() body: Record<string, unknown>) {
    return this.documents.create(body);
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
