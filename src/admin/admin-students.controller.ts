import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminJwtGuard } from '../auth/admin-jwt.guard';
import { AdminStudentsService } from './admin-students.service';

@Controller('admin/students')
@UseGuards(AdminJwtGuard)
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
