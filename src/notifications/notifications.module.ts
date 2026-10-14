import { Global, Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';

import { AuthModule } from '../auth/auth.module';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';

/** Global so ride and realtime code can notify without circular imports. */
@Global()
@Module({
  imports: [HttpModule.register({ timeout: 10_000, maxRedirects: 0 }), AuthModule],
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
