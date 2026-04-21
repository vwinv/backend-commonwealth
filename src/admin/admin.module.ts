import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { EnrollmentsModule } from '../enrollments/enrollments.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AdminDashboardController } from './admin-dashboard.controller';
import { AdminDashboardService } from './admin-dashboard.service';
import { AdminEnrollmentsController } from './admin-enrollments.controller';
import { AdminEnrollmentsService } from './admin-enrollments.service';
import { AdminSettingsController } from './admin-settings.controller';
import { AdminSettingsService } from './admin-settings.service';
import { AdminParentsController } from './admin-parents.controller';
import { AdminParentsService } from './admin-parents.service';
import { AdminPaymentsController } from './admin-payments.controller';
import { AdminPaymentsService } from './admin-payments.service';
import { AdminDocumentsController } from './admin-documents.controller';
import { AdminDocumentsService } from './admin-documents.service';
import { AdminStudentsController } from './admin-students.controller';
import { AdminStudentsService } from './admin-students.service';

@Module({
  imports: [PrismaModule, AuthModule, EnrollmentsModule, BillingModule, NotificationsModule],
  controllers: [
    AdminDashboardController,
    AdminEnrollmentsController,
    AdminStudentsController,
    AdminParentsController,
    AdminPaymentsController,
    AdminDocumentsController,
    AdminSettingsController,
  ],
  providers: [
    AdminDashboardService,
    AdminEnrollmentsService,
    AdminStudentsService,
    AdminParentsService,
    AdminPaymentsService,
    AdminDocumentsService,
    AdminSettingsService,
  ],
})
export class AdminModule {}
