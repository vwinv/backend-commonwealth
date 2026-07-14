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
import { AdminAteliersService } from './admin-ateliers.service';

@Controller('admin/ateliers')
@UseGuards(AdminJwtGuard, AdminMustChangePasswordGuard, AdminPermissionGuard)
@RequireAppModule(AppModuleRole.PROGRAMME)
export class AdminAteliersController {
  constructor(private readonly ateliers: AdminAteliersService) {}

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
    FileInterceptor('file', {
      storage: diskStorage({
        destination: (_req, _file, cb) => {
          const dir = join(process.cwd(), 'uploads', 'ateliers');
          mkdirSync(dir, { recursive: true });
          cb(null, dir);
        },
        filename: (_req, file, cb) => {
          const ext = extname(file.originalname) || '.jpg';
          cb(null, `${Date.now()}-${randomBytes(8).toString('hex')}${ext.toLowerCase()}`);
        },
      }),
      limits: { fileSize: 2 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => {
        const ok = /\.(png|jpe?g|webp)$/i.test(file.originalname);
        cb(null, ok);
      },
    }),
  )
  upload(@UploadedFile() file: Express.Multer.File, @Req() req: Request) {
    if (!file) throw new BadRequestException('Image requise (PNG, JPG ou WEBP, max 2 Mo).');
    const publicPath = `/uploads/ateliers/${file.filename}`;
    const proto = req.get('x-forwarded-proto') ?? req.protocol;
    const host = req.get('host');
    const url = host ? `${proto}://${host}${publicPath}` : publicPath;
    return { url, path: publicPath, filename: file.originalname };
  }

  @Post()
  create(@Body() body: Record<string, unknown>) {
    return this.ateliers.create(body);
  }

  @Patch(':id/publish')
  setPublished(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.ateliers.setPublished(id, body);
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
