import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { MailService } from './mail.service';

const unpaidReminderCron =
  process.env.UNPAID_INVOICE_REMINDER_CRON?.trim() || CronExpression.EVERY_DAY_AT_7AM;

@Injectable()
export class UnpaidInvoiceReminderScheduler {
  private readonly logger = new Logger(UnpaidInvoiceReminderScheduler.name);

  constructor(
    private readonly mail: MailService,
    private readonly config: ConfigService,
  ) {}

  @Cron(unpaidReminderCron)
  async handleDailyMultipleUnpaidInvoiceReminders(): Promise<void> {
    if (this.config.get<string>('UNPAID_INVOICE_REMINDER_DISABLED')?.trim() === 'true') {
      return;
    }
    try {
      await this.mail.runDailyMultipleUnpaidInvoiceReminderBatch();
    } catch (e) {
      this.logger.error(
        `Relance quotidienne factures impayées: ${e instanceof Error ? e.stack ?? e.message : String(e)}`,
      );
    }
  }
}
