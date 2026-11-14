import { Module } from '@nestjs/common';

import { PoolService } from './pool.service';

/**
 * Data and matching for shared trips. The HTTP endpoints live in
 * RidesModule (PoolController) because joining a trip creates a ride, and
 * keeping them there keeps the dependency one-way: rides -> pool.
 */
@Module({
  providers: [PoolService],
  exports: [PoolService],
})
export class PoolModule {}
