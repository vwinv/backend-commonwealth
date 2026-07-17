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
  UseGuards,
} from '@nestjs/common';
import { AppModuleRole } from '@prisma/client';
import { AdminJwtGuard } from '../auth/admin-jwt.guard';
import { AdminPermissionGuard } from '../auth/admin-permission.guard';
import { AdminMustChangePasswordGuard } from '../auth/admin-must-change-password.guard';
import { RequireAppModule } from '../auth/require-app-module.decorator';
import { AdminProgrammeService } from './admin-programme.service';

@Controller('admin/programme')
@UseGuards(AdminJwtGuard, AdminMustChangePasswordGuard, AdminPermissionGuard)
@RequireAppModule(AppModuleRole.PROGRAMME)
export class AdminProgrammeController {
  constructor(private readonly programme: AdminProgrammeService) {}

  @Get()
  overview(@Query('schoolYear') schoolYear?: string, @Query('category') category?: string) {
    return this.programme.getOverview({ schoolYear, category });
  }

  @Get('categories')
  listCategories() {
    return this.programme.listCategories(true);
  }

  @Post('categories')
  createCategory(@Body() body: Record<string, unknown>) {
    return this.programme.createCategory(body);
  }

  @Patch('categories/:id')
  updateCategory(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.programme.updateCategory(id, body);
  }

  @Delete('categories/:id')
  @HttpCode(HttpStatus.OK)
  removeCategory(@Param('id') id: string) {
    return this.programme.removeCategory(id);
  }

  @Post()
  create(@Body() body: Record<string, unknown>) {
    return this.programme.create(body);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.programme.update(id, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  remove(@Param('id') id: string) {
    return this.programme.remove(id);
  }
}
