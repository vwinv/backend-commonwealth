import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { PaymentsService } from './payments.service';

/** IPN PayDunya (public) — la facture n’est marquée payée qu’après confirm API. */
@Controller('payments/paydunya')
export class PaydunyaIpnController {
  constructor(private readonly payments: PaymentsService) {}

  @Post('ipn')
  @HttpCode(200)
  ipn(@Body() body: Record<string, unknown>) {
    return this.payments.handlePaydunyaIpn(body ?? {});
  }
}
