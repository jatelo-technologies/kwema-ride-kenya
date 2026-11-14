import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { PoolModule } from '../pool/pool.module';
import { AdminService } from './admin.service';
import { AdminController } from './admin.controller';

@Module({
  imports: [AuthModule, PoolModule],
  controllers: [AdminController],
  providers: [AdminService],
  exports: [AdminService],
})
export class AdminModule {}
