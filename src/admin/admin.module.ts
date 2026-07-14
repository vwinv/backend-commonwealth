import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { EnrollmentsModule } from '../enrollments/enrollments.module';
import { MailModule } from '../mail/mail.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PaymentsModule } from '../payments/payments.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AdminDashboardController } from './admin-dashboard.controller';
import { AdminDashboardService } from './admin-dashboard.service';
import { AdminEnrollmentsController } from './admin-enrollments.controller';
import { AdminEnrollmentsService } from './admin-enrollments.service';
import { AdminSettingsController } from './admin-settings.controller';
import { AdminSettingsService } from './admin-settings.service';
import { AdminParentsController } from './admin-parents.controller';
import { AdminParentsService } from './admin-parents.service';
import { AdminAccountingController } from './admin-accounting.controller';
import { AdminAccountingService } from './admin-accounting.service';
import { AdminPaymentsController } from './admin-payments.controller';
import { AdminPaymentsService } from './admin-payments.service';
import { AdminDocumentsController } from './admin-documents.controller';
import { AdminDocumentsService } from './admin-documents.service';
import { AdminProgrammeController } from './admin-programme.controller';
import { AdminProgrammeService } from './admin-programme.service';
import { AdminUsersController } from './admin-users.controller';
import { AdminUsersService } from './admin-users.service';
import { AdminAteliersController } from './admin-ateliers.controller';
import { AdminAteliersService } from './admin-ateliers.service';
import { PublicAteliersController } from './public-ateliers.controller';
import { AdminStudentsController } from './admin-students.controller';
import { AdminStudentsService } from './admin-students.service';

@Module({
  imports: [PrismaModule, AuthModule, MailModule, EnrollmentsModule, BillingModule, NotificationsModule, PaymentsModule],
  controllers: [
    AdminDashboardController,
    AdminEnrollmentsController,
    AdminStudentsController,
    AdminParentsController,
    AdminPaymentsController,
    AdminAccountingController,
    AdminDocumentsController,
    AdminProgrammeController,
    AdminAteliersController,
    PublicAteliersController,
    AdminSettingsController,
    AdminUsersController,
  ],
  providers: [
    AdminDashboardService,
    AdminEnrollmentsService,
    AdminStudentsService,
    AdminParentsService,
    AdminPaymentsService,
    AdminAccountingService,
    AdminDocumentsService,
    AdminProgrammeService,
    AdminAteliersService,
    AdminSettingsService,
    AdminUsersService,
  ],
})
export class AdminModule {}
