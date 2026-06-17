import {
  Body,
  Controller,
  Get,
  Header,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AppModuleRole } from '@prisma/client';
import type { Request } from 'express';
import { AdminJwtGuard, type AdminJwtPayload } from '../auth/admin-jwt.guard';
import { AdminPermissionGuard } from '../auth/admin-permission.guard';
import { AdminMustChangePasswordGuard } from '../auth/admin-must-change-password.guard';
import { RequireAppModule } from '../auth/require-app-module.decorator';
import { AdminAccountingService } from './admin-accounting.service';

type AdminRequest = Request & { adminUser?: AdminJwtPayload };

@Controller('admin/accounting')
@UseGuards(AdminJwtGuard, AdminMustChangePasswordGuard, AdminPermissionGuard)
@RequireAppModule(AppModuleRole.FINANCE)
export class AdminAccountingController {
  constructor(private readonly accounting: AdminAccountingService) {}

  @Get('overview')
  overview(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @Query('service') service?: string,
    @Query('year') year?: string,
    @Query('month') month?: string,
  ) {
    return this.accounting.getOverview({
      page: page !== undefined && page !== '' ? parseInt(page, 10) : undefined,
      limit: limit !== undefined && limit !== '' ? parseInt(limit, 10) : undefined,
      search: search || undefined,
      service: service || undefined,
      year: year !== undefined && year !== '' ? parseInt(year, 10) : undefined,
      month: month !== undefined && month !== '' ? parseInt(month, 10) : undefined,
    });
  }

  @Get('export')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="comptabilite.csv"')
  exportCsv(@Query('search') search?: string, @Query('service') service?: string) {
    return this.accounting.exportCsv({ search: search || undefined, service: service || undefined });
  }

  @Post('cash/open')
  openCash(@Req() req: AdminRequest) {
    return this.accounting.openCashSession(req.adminUser?.sub);
  }

  @Post('cash/close')
  closeCash() {
    return this.accounting.closeCashSession();
  }

  @Get('cash/desk')
  cashDesk(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
  ) {
    return this.accounting.getCashDesk({
      page: page !== undefined && page !== '' ? parseInt(page, 10) : undefined,
      limit: limit !== undefined && limit !== '' ? parseInt(limit, 10) : undefined,
      search: search || undefined,
    });
  }

  @Post('cash/manual-entries')
  addManualEntry(
    @Body()
    body: {
      description?: string;
      amountCents?: number;
      paymentMethod?: string;
      source?: string;
      invoiceNumber?: string;
      entryDate?: string;
      hasInvoice?: boolean;
    },
  ) {
    return this.accounting.addManualEntry(body);
  }

  @Get('cash/lookup-invoice')
  lookupInvoice(@Query('number') number?: string) {
    return this.accounting.lookupCashInvoiceByNumber(number ?? '');
  }

  @Get('cash/unpaid-bills')
  unpaidBills(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
  ) {
    return this.accounting.getCashUnpaidBills({
      page: page !== undefined && page !== '' ? parseInt(page, 10) : undefined,
      limit: limit !== undefined && limit !== '' ? parseInt(limit, 10) : undefined,
      search: search || undefined,
    });
  }

  @Post('cash/pay-bill')
  payBill(
    @Body()
    body: {
      billId?: string;
      paymentMethod?: string;
      hasInvoice?: boolean;
    },
  ) {
    return this.accounting.payCashBill(body);
  }

  @Post('cash/expenses')
  addExpense(
    @Body()
    body: {
      label?: string;
      amountCents?: number;
      paymentMethod?: string;
      expenseDate?: string;
      hasInvoice?: boolean;
    },
  ) {
    return this.accounting.addCashExpense(body);
  }
}
