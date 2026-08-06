import { Controller, Get } from '@nestjs/common';
import { AdminLandingService } from './admin-landing.service';

@Controller('public/landing')
export class PublicLandingController {
  constructor(private readonly landing: AdminLandingService) {}

  @Get()
  get() {
    return this.landing.getContent();
  }
}
