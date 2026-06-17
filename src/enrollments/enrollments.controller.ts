import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { EnrollmentsService } from './enrollments.service';

@Controller()
export class EnrollmentsController {
  constructor(private readonly enrollments: EnrollmentsService) {}

  // Public (parents) - create an online enrollment
  @Post('public/enrollments')
  createPublicEnrollment(@Body() body: any) {
    return this.enrollments.createPublicEnrollment(body);
  }

  @Post('public/enrollments/options')
  savePublicEnrollmentOptions(@Body() body: any) {
    return this.enrollments.savePublicEnrollmentOptions(body);
  }

  @Post('public/enrollments/batch')
  createPublicEnrollmentBatch(@Body() body: any) {
    return this.enrollments.createPublicEnrollmentBatch(body);
  }

  @Post('public/enrollments/health')
  savePublicEnrollmentHealth(@Body() body: any) {
    return this.enrollments.savePublicEnrollmentHealth(body);
  }

  @Post('public/enrollments/family')
  savePublicEnrollmentFamily(@Body() body: any) {
    return this.enrollments.savePublicEnrollmentFamily(body);
  }

  @Get('public/enrollments/resume/:token')
  getPublicEnrollmentResume(@Param('token') token: string) {
    return this.enrollments.getPublicEnrollmentResume(token);
  }

  // Backoffice - list enrollments
  @Get('backoffice/enrollments')
  list(@Query('status') status?: string) {
    return this.enrollments.list({ status });
  }

  @Get('backoffice/enrollments/:id')
  getOne(@Param('id') id: string) {
    return this.enrollments.getOne(id);
  }

  @Patch('backoffice/enrollments/:id/approve')
  approve(@Param('id') id: string, @Body() body: any) {
    return this.enrollments.approve(id, body);
  }

  @Patch('backoffice/enrollments/:id/reject')
  reject(@Param('id') id: string, @Body() body: any) {
    return this.enrollments.reject(id, body);
  }
}

