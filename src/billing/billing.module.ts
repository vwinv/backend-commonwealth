import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { PricingController } from './pricing.controller';

@Module({
  imports: [PrismaModule],
  controllers: [BillingController, PricingController],
  providers: [BillingService],
  exports: [BillingService],
})
export class BillingModule {}
