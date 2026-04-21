import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { PaymentsService } from './payments.service';

@Controller('backoffice')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post('payments')
  recordPayment(@Body() body: any) {
    return this.payments.recordPayment(body);
  }

  @Get('enrollments/:enrollmentId/payments')
  listEnrollmentPayments(@Param('enrollmentId') enrollmentId: string) {
    return this.payments.listEnrollmentPayments(enrollmentId);
  }

  @Post('paydunya/checkout-invoice')
  createPaydunyaCheckoutInvoice(@Body() body: Record<string, unknown>) {
    return this.payments.createPaydunyaCheckoutInvoice(body);
  }

  @Post('paydunya/softpay/:provider')
  triggerPaydunyaSoftpay(
    @Param('provider') provider: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.payments.triggerPaydunyaSoftpay(provider, body);
  }

  @Get('paydunya/checkout-invoice/:token/status')
  verifyPaydunyaCheckoutStatus(@Param('token') token: string) {
    return this.payments.verifyPaydunyaCheckoutStatus(token);
  }
}

