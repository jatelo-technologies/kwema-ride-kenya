import { Module, forwardRef } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { SafetyService } from './safety.service';
import { SafetyController } from './safety.controller';
import { ShareModule } from '../share/share.module';

@Module({
  imports: [AuthModule, ShareModule, forwardRef(() => RealtimeModule)],
  controllers: [SafetyController],
  providers: [SafetyService],
  exports: [SafetyService],
})
export class SafetyModule {}
