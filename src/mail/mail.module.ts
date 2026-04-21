import { Global, Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { MailService } from './mail.service';
import { UnpaidInvoiceReminderScheduler } from './unpaid-invoice-reminder.scheduler';

@Global()
@Module({
  imports: [NotificationsModule],
  providers: [MailService, UnpaidInvoiceReminderScheduler],
  exports: [MailService],
})
export class MailModule {}
