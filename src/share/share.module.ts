import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { ShareService } from './share.service';
import { ShareController, PublicShareController } from './share.controller';

@Module({
  imports: [AuthModule],
  controllers: [ShareController, PublicShareController],
  providers: [ShareService],
  exports: [ShareService],
})
export class ShareModule {}
