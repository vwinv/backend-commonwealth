import { Controller, Get, Param } from '@nestjs/common';
import { CatalogService } from './catalog.service';

@Controller('public/catalog')
export class PublicCatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('levels')
  listLevels() {
    return this.catalog.listLevelsForEnrollment();
  }

  @Get('school-year/active')
  activeSchoolYear() {
    return this.catalog.activeSchoolYear();
  }

  @Get('levels/:levelId/schedules')
  listLevelSchedules(@Param('levelId') levelId: string) {
    return this.catalog.listLevelSchedulesForEnrollment(levelId);
  }

  @Get('services')
  listServices() {
    return this.catalog.listServicesForEnrollment();
  }

  @Get('levels/:levelId/classes')
  listClasses(@Param('levelId') levelId: string) {
    return this.catalog.listClasses(levelId);
  }
}

