import { Module } from '@nestjs/common';
import { CatalogController } from './catalog.controller';
import { CatalogService } from './catalog.service';
import { PublicCatalogController } from './public-catalog.controller';

@Module({
  controllers: [CatalogController, PublicCatalogController],
  providers: [CatalogService],
})
export class CatalogModule {}

