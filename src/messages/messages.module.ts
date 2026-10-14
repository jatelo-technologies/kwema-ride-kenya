import { Module, forwardRef } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { MessagesService } from './messages.service';
import { MessagesController } from './messages.controller';

@Module({
  imports: [AuthModule, forwardRef(() => RealtimeModule)],
  controllers: [MessagesController],
  providers: [MessagesService],
})
export class MessagesModule {}
