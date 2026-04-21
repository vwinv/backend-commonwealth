import { Controller, Param, Post } from '@nestjs/common';
import { BillingService } from './billing.service';

@Controller('backoffice/billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Post('enrollments/:id/sync')
  syncEnrollment(@Param('id') id: string) {
    return this.billing.syncEnrollmentBilling(id);
  }
}
