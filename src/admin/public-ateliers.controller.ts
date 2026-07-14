import { Controller, Get } from '@nestjs/common';
import { AdminAteliersService } from './admin-ateliers.service';

@Controller('public/ateliers')
export class PublicAteliersController {
  constructor(private readonly ateliers: AdminAteliersService) {}

  @Get()
  listPublished() {
    return this.ateliers.listPublished();
  }
}
