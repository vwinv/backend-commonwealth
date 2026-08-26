import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PaydunyaIpnController } from './paydunya-ipn.controller';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

@Module({
  imports: [AuthModule],
  controllers: [PaymentsController, PaydunyaIpnController],
  providers: [PaymentsService],
  exports: [PaymentsService],
})
export class PaymentsModule {}

