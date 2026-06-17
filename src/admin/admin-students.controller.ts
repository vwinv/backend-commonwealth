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
  UnauthorizedException,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { randomBytes } from 'crypto';
import { diskStorage } from 'multer';
import { extname, join } from 'path';
import { mkdirSync } from 'fs';
import type { Request } from 'express';
import { AppModuleRole } from '@prisma/client';
import { AdminJwtGuard } from '../auth/admin-jwt.guard';
import type { AdminJwtPayload } from '../auth/admin-jwt.guard';
import { AdminPermissionGuard } from '../auth/admin-permission.guard';
import { AdminMustChangePasswordGuard } from '../auth/admin-must-change-password.guard';
import { RequireAppModule } from '../auth/require-app-module.decorator';
import { AdminStudentsService } from './admin-students.service';

type AdminRequest = Request & { adminUser?: AdminJwtPayload };

@Controller('admin/students')
@UseGuards(AdminJwtGuard, AdminMustChangePasswordGuard, AdminPermissionGuard)
@RequireAppModule(AppModuleRole.ELEVES)
export class AdminStudentsController {
  constructor(private readonly students: AdminStudentsService) {}

  @Get()
  overview(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @Query('sort') sort?: string,
  ) {
    return this.students.getOverview({
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      search: search || undefined,
      sort: sort || undefined,
    });
  }

  @Get('school-years')
  schoolYears() {
    return this.students.listSchoolYears();
  }

  @Get(':id/follow-up-notes')
  listFollowUpNotes(@Param('id') id: string) {
    return this.students.listFollowUpNotes(id);
  }

  @Post(':id/follow-up-notes/publish-day')
  publishFollowUpDay(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.students.publishFollowUpDay(id, body.noteDate);
  }

  @Post(':id/follow-up-notes')
  createFollowUpNote(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @Req() req: AdminRequest,
  ) {
    const authorId = req.adminUser?.sub;
    if (!authorId) {
      throw new UnauthorizedException();
    }
    return this.students.createFollowUpNote(id, authorId, body);
  }

  @Patch(':id/follow-up-notes/:noteId')
  updateFollowUpNote(
    @Param('id') id: string,
    @Param('noteId') noteId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.students.updateFollowUpNote(id, noteId, body);
  }

  @Delete(':id/follow-up-notes/:noteId')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteFollowUpNote(@Param('id') id: string, @Param('noteId') noteId: string) {
    return this.students.deleteFollowUpNote(id, noteId);
  }

  @Get(':id/health-record')
  healthRecord(@Param('id') id: string) {
    return this.students.getHealthRecord(id);
  }

  @Patch(':id/health-record')
  updateHealthRecord(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.students.updateHealthRecord(id, body);
  }

  @Post(':id/health-record/school-signature')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: (_req, _file, cb) => {
          const dir = join(process.cwd(), 'uploads', 'health-signatures');
          mkdirSync(dir, { recursive: true });
          cb(null, dir);
        },
        filename: (_req, file, cb) => {
          const ext = extname(file.originalname) || '.png';
          cb(null, `${Date.now()}-${randomBytes(8).toString('hex')}${ext.toLowerCase()}`);
        },
      }),
      limits: { fileSize: 5 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => {
        const ok = /\.(png|jpe?g|webp)$/i.test(file.originalname);
        cb(null, ok);
      },
    }),
  )
  async signSchoolHealthRecord(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Req() req: AdminRequest,
  ) {
    const adminUserId = req.adminUser?.sub;
    if (!adminUserId) throw new UnauthorizedException();

    const type = String(body.type ?? '').trim().toUpperCase();
    let signatureImageUrl: string | undefined;
    if (type === 'IMAGE' || type === 'HANDWRITTEN') {
      if (!file) {
        throw new BadRequestException('Image requise (PNG, JPG, JPEG, WEBP).');
      }
      const publicPath = `/uploads/health-signatures/${file.filename}`;
      const proto = req.get('x-forwarded-proto') ?? req.protocol;
      const host = req.get('host');
      signatureImageUrl = host ? `${proto}://${host}${publicPath}` : publicPath;
    }

    return this.students.signSchoolHealthRecord(id, adminUserId, body, signatureImageUrl);
  }

  @Post(':id/health-record/request-parent-signature')
  requestParentHealthSignature(@Param('id') id: string) {
    return this.students.requestParentHealthSignature(id);
  }

  @Get(':id')
  profile(@Param('id') id: string) {
    return this.students.getProfile(id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.students.updateChild(id, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id') id: string) {
    return this.students.deleteChild(id);
  }
}
