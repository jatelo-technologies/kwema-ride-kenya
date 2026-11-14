import { Module, forwardRef } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { DeliveriesModule } from '../deliveries/deliveries.module';
import { RidesService } from './rides.service';
import { RidesController } from './rides.controller';
import { DispatchModule } from '../dispatch/dispatch.module';
import { PricingModule } from '../pricing/pricing.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { PoolModule } from '../pool/pool.module';
import { PoolController } from '../pool/pool.controller';

@Module({
  imports: [AuthModule, DeliveriesModule, DispatchModule, PricingModule, PoolModule,
    forwardRef(() => RealtimeModule)],
  controllers: [RidesController, PoolController],
  providers: [RidesService],
  exports: [RidesService],
})
export class RidesModule {}
