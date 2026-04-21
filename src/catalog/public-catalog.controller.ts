import { Controller, Get, Param } from '@nestjs/common';
import { CatalogService } from './catalog.service';

@Controller('public/catalog')
export class PublicCatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('levels')
  listLevels() {
    return this.catalog.listLevels();
  }

  @Get('school-year/active')
  activeSchoolYear() {
    return this.catalog.activeSchoolYear();
  }

  @Get('levels/:levelId/classes')
  listClasses(@Param('levelId') levelId: string) {
    return this.catalog.listClasses(levelId);
  }
}

