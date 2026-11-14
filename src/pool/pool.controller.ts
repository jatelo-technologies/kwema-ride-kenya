import {
  BadRequestException, Body, Controller, Get, Inject, NotFoundException,
  Param, Post, Query, UseGuards,
} from '@nestjs/common';
import { IsIn, IsNumber, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import Redis from 'ioredis';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser, AuthedUser } from '../auth/current-user.decorator';
import { REDIS } from '../common/redis.module';
import { RidesService } from '../rides/rides.service';
import { PoolService } from './pool.service';
import { POOL, POOL_SEATS, discountBpsFor, isPoolCategory } from './pool.config';
import { DataSource } from 'typeorm';

class PointDto {
  @IsNumber() lat: number;
  @IsNumber() lng: number;
  @IsOptional() @IsString() address?: string;
}

class JoinDto {
  @IsString() clientGeneratedId: string;
  @IsString() quoteId: string;
  @IsIn(['bajaji', 'e_bajaji', 'standard', 'e_car', 'xl']) category: string;
  @IsIn(['cash', 'mobile_money', 'card', 'wallet']) paymentMethod: string;
  @ValidateNested() @Type(() => PointDto) pickup: PointDto;
  @ValidateNested() @Type(() => PointDto) dropoff: PointDto;
}

const ACTIVE = `('requested','searching','accepted','arrived','in_progress')`;

/**
 * Shared trips: browse the ones near you, and join one.
 *
 * Starting a pooled ride (live match, or hosting a shared trip) is an option
 * on the ordinary POST /rides/request, not a separate flow, so pooling never
 * replaces solo booking.
 */
@Controller('pool')
@UseGuards(JwtAuthGuard)
export class PoolController {
  constructor(
    private readonly pool: PoolService,
    private readonly rides: RidesService,
    private readonly db: DataSource,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** What the apps need to decide whether to show the Pool option at all. */
  @Get('config')
  config() {
    return {
      enabled: POOL.enabled,
      seats: POOL_SEATS,
      discountBps: POOL.discountBps,
    };
  }

  /**
   * Shared trips this rider could join for the route they have in mind,
   * least detour first. Only first names and areas are shown to other riders.
   */
  @Get('trips')
  async trips(
    @CurrentUser() user: AuthedUser,
    @Query('category') category: string,
    @Query('pickupLat') pickupLat: string,
    @Query('pickupLng') pickupLng: string,
    @Query('dropoffLat') dropoffLat: string,
    @Query('dropoffLng') dropoffLng: string,
  ) {
    const pickup = { lat: Number(pickupLat), lng: Number(pickupLng) };
    const dropoff = { lat: Number(dropoffLat), lng: Number(dropoffLng) };
    if (![pickup.lat, pickup.lng, dropoff.lat, dropoff.lng].every(Number.isFinite)) {
      throw new BadRequestException('invalid_coordinates');
    }
    if (!isPoolCategory(category)) return { enabled: POOL.enabled, trips: [] };

    const matches = await this.pool.matchesFor({ riderId: user.id, category, pickup, dropoff });
    return {
      enabled: POOL.enabled,
      trips: matches.slice(0, POOL.browseLimit).map((m) => {
        const host = m.trip.riders[0];
        return {
          tripId: m.trip.id,
          category: m.trip.category,
          seatsLeft: m.trip.seatsLeft,
          coRiders: m.trip.riders.length,
          hasDriver: Boolean(m.trip.driverId),
          hostFirstName: (host.riderName ?? '').split(' ')[0] || null,
          fromArea: host.pickupAddress,
          toArea: host.dropoffAddress,
          detourM: m.verdict.detourM,
          toPickupM: m.verdict.toPickupM,
        };
      }),
    };
  }

  /** Joins a shared trip. Same quote, payment and receipt rules as any ride. */
  @Post('trips/:id/join')
  async join(
    @CurrentUser() user: AuthedUser,
    @Param('id') tripId: string,
    @Body() dto: JoinDto,
  ) {
    if (!POOL.enabled || !isPoolCategory(dto.category)) {
      throw new BadRequestException('pool_unavailable');
    }

    // One joiner at a time per trip, so the last seat cannot be sold twice.
    const lockKey = `pool:trip:lock:${tripId}`;
    const locked = await this.redis.set(lockKey, user.id, 'EX', 8, 'NX');
    if (locked !== 'OK') throw new BadRequestException('trip_busy');

    try {
      const [mine] = await this.db.query(
        `SELECT id FROM rides WHERE rider_id = $1 AND status IN ${ACTIVE} LIMIT 1`,
        [user.id],
      );
      if (mine) throw new BadRequestException('ride_already_active');

      const match = await this.pool.checkJoin(tripId, {
        riderId: user.id,
        category: dto.category,
        pickup: { lat: dto.pickup.lat, lng: dto.pickup.lng },
        dropoff: { lat: dto.dropoff.lat, lng: dto.dropoff.lng },
      });
      if (!match) throw new NotFoundException('trip_not_joinable');

      // With a driver already on the road the driver is asked first and the
      // rider is linked on acceptance. Without one, the rider waits on the
      // trip and takes the driver the host is given.
      const waiting = !match.trip.driverId;
      const ride = await this.rides.createOrGet(user.id, {
        ...dto,
        poolMode: 'join',
        poolTripId: waiting ? tripId : null,
      });

      if (waiting) {
        await this.rides.joinRiderRoom(user.id, ride.id);
        await this.rides.broadcastPoolCount(tripId);
      } else {
        void this.rides.startPoolJoin(ride.id, tripId);
      }

      return this.rides.toWireSummary(ride);
    } finally {
      await this.redis.del(lockKey);
    }
  }
}
