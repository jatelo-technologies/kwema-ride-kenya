import { Module, forwardRef } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';

import { AuthModule } from '../auth/auth.module';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { MpesaProvider, MtnMomoProvider, AirtelMoneyProvider } from './mobile-money.providers';
import { DpoCardProvider } from './card.provider';
import { CashService } from './cash.service';
import { PayoutsService } from './payouts.service';
import { PayoutsController } from './payouts.controller';
import { RealtimeModule } from '../realtime/realtime.module';

@Module({
  imports: [
    HttpModule.register({ timeout: 20_000, maxRedirects: 0 }),
    forwardRef(() => RealtimeModule),
    AuthModule,
  ],
  controllers: [PaymentsController, PayoutsController],
  providers: [PaymentsService, MpesaProvider, MtnMomoProvider, AirtelMoneyProvider, DpoCardProvider, CashService, PayoutsService],
  exports: [PaymentsService, CashService],
})
export class PaymentsModule {}
