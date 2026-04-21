import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { CatalogService } from './catalog.service';

@Controller('backoffice/catalog')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('levels')
  listLevels() {
    return this.catalog.listLevels();
  }

  @Post('levels')
  createLevel(@Body() body: any) {
    return this.catalog.createLevel(body);
  }

  @Get('levels/:levelId/classes')
  listClasses(@Param('levelId') levelId: string) {
    return this.catalog.listClasses(levelId);
  }

  @Post('classes')
  createClass(@Body() body: any) {
    return this.catalog.createClass(body);
  }

  @Post('documents')
  createDocument(@Body() body: any) {
    return this.catalog.createDocument(body);
  }

  @Post('levels/:levelId/documents/:documentId')
  attachDocument(
    @Param('levelId') levelId: string,
    @Param('documentId') documentId: string,
  ) {
    return this.catalog.attachDocument(levelId, documentId);
  }
}

