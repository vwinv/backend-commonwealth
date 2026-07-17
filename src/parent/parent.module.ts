import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { MailModule } from '../mail/mail.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PaymentsModule } from '../payments/payments.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ParentController } from './parent.controller';
import { ParentInvoicePdfService } from './parent-invoice-pdf.service';
import { ParentService } from './parent.service';

@Module({
  imports: [AuthModule, PrismaModule, BillingModule, PaymentsModule, NotificationsModule, MailModule],
  controllers: [ParentController],
  providers: [ParentService, ParentInvoicePdfService],
})
export class ParentModule {}
