import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { AdminAteliersService } from './admin-ateliers.service';

@Controller('public/ateliers')
export class PublicAteliersController {
  constructor(private readonly ateliers: AdminAteliersService) {}

  @Get()
  listPublished() {
    return this.ateliers.listPublished();
  }

  @Get(':workshopId')
  getPublished(@Param('workshopId') workshopId: string) {
    return this.ateliers.getPublishedById(workshopId);
  }

  @Post(':workshopId/register')
  register(
    @Param('workshopId') workshopId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.ateliers.registerFromPublic(workshopId, body ?? {});
  }
}
