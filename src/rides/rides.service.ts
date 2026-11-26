/**
 * RidesService — the ride lifecycle and the orchestration around dispatch.
 *
 * Two things here are load-bearing and worth reading before changing:
 *
 *  1. `claim` is the only place a ride gets a driver, and it does so with a
 *     conditional UPDATE (`WHERE driver_id IS NULL`). Two drivers tapping
 *     accept in the same millisecond both reach this statement; exactly one
 *     row is updated and the other gets zero. No lock, no race.
 *
 *  2. Fares are always computed server-side from the breadcrumb trail, never
 *     from a distance the driver app reports. A device that reports its own
 *     mileage is a device that can be modified to report more.
 */

import { Injectable, Inject, Logger, BadRequestException, ConflictException, forwardRef } from '@nestjs/common';
import { DataSource } from 'typeorm';
import Redis from 'ioredis';
import * as crypto from 'node:crypto';

import { REDIS } from '../common/redis.module';
import { DispatchService, ScoredDriver, VehicleCategory } from '../dispatch/dispatch.service';
import { FareService } from '../pricing/fare.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { maskPhone, country } from '../common/country';
import { NotificationsService } from '../notifications/notifications.service';
import { MsgKey } from '../common/messages';
import { PoolService, TripMatch } from '../pool/pool.service';
import { POOL, discountBpsFor, isPoolCategory } from '../pool/pool.config';

export interface BreadcrumbInput {
  driverId: string;
  rideId: string | null;
  lat: number;
  lng: number;
  headingDeg: number | null;
  speedKph: number | null;
  accuracyM: number | null;
  recordedAt: Date;
  isBackfilled: boolean;
}

const OFFER_TTL_SECONDS = 15;

/** Rides one rider may have open at once for other people. */
const MAX_ACTIVE_FOR_OTHERS = 5;

@Injectable()
export class RidesService {
  private readonly logger = new Logger(RidesService.name);

  /** Buffered breadcrumbs, flushed in batches. See `flushBreadcrumbs`. */
  private breadcrumbBuffer: BreadcrumbInput[] = [];

  constructor(
    private readonly db: DataSource,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly dispatch: DispatchService,
    private readonly fares: FareService,
    @Inject(forwardRef(() => RealtimeGateway))
    private readonly gateway: RealtimeGateway,
    private readonly push: NotificationsService,
    private readonly pool: PoolService,
  ) {}

  /** Push to the offered driver, for when the app is in the background. */
  private async pushDriverOffer(driverId: string, rideId: string): Promise<void> {
    const [d] = await this.db.query(`SELECT user_id FROM drivers WHERE id = $1`, [driverId]);
    if (!d) return;
    await this.push.sendToUser(
      d.user_id,
      {
        title: 'push.ride_request.t',
        body: 'push.ride_request.b',
        data: { type: 'ride_offer', rideId },
      },
      'driver',
    );
  }

  /** Push to the rider when the trip moves, for a backgrounded app. */
  async notifyRider(rideId: string, status: string): Promise<void> {
    const copy: Record<string, { t: MsgKey; b: MsgKey }> = {
      accepted: { t: 'push.accepted.t', b: 'push.accepted.b' },
      arrived: { t: 'push.arrived.t', b: 'push.arrived.b' },
      completed: { t: 'push.completed.t', b: 'push.completed.b' },
    };
    const c = copy[status];
    if (!c) return;
    const [r] = await this.db.query(`SELECT rider_id FROM rides WHERE id = $1`, [rideId]);
    if (!r) return;
    await this.push.sendToUser(
      r.rider_id,
      { title: c.t, body: c.b, data: { type: 'ride_status', rideId, status } },
      'rider',
    );
  }

  // ===================================================================
  // Creation
  // ===================================================================

  /**
   * Idempotent on (rider, clientGeneratedId). A retry after a dropped ack on
   * a 3G connection returns the existing ride instead of creating a second.
   */
  async createOrGet(riderId: string, body: any) {
    const [existing] = await this.db.query(
      `SELECT * FROM rides WHERE rider_id = $1 AND client_generated_id = $2`,
      [riderId, body.clientGeneratedId],
    );
    if (existing) return existing;

    // The quote is authoritative for price. An expired quote is refused
    // rather than silently re-priced at whatever surge is current.
    const cached = await this.redis.get(`quote:${body.quoteId}`);
    if (!cached) throw new BadRequestException('quote_expired');
    const { fare, poolPreview, input: quotedInput } = JSON.parse(cached);

    // Pooling is an extra option on an ordinary ride request, never a
    // replacement for it. It needs a vehicle that can seat strangers, and a
    // quote that was priced for pooling.
    const poolMode: string | null = body.poolMode ?? null;
    if (poolMode) {
      if (!POOL.enabled || !isPoolCategory(body.category) || !poolPreview) {
        throw new BadRequestException('pool_unavailable');
      }
    }

    // Rides booked for other people. The rider's own ride is limited to one
    // per service by a database index; these are capped here instead.
    const passengerName: string | null = body.passengerName?.trim() || null;
    const passengerPhone: string | null = body.passengerPhone?.trim() || null;
    if (passengerName) {
      const [{ n }] = await this.db.query(
        `SELECT count(*)::int AS n FROM rides
          WHERE rider_id = $1 AND passenger_name IS NOT NULL
            AND status IN ('requested','searching','accepted','arrived','in_progress')`,
        [riderId],
      );
      if (n >= MAX_ACTIVE_FOR_OTHERS) {
        throw new BadRequestException('too_many_active_rides');
      }
    }

    const reference = this.generateReference();

    let ride: any;
    try {
      [ride] = await this.db.query(
      `INSERT INTO rides (
          passenger_name, passenger_phone,
          reference, client_generated_id, rider_id, requested_category, status,
          pickup_point, pickup_address, dropoff_point, dropoff_address,
          pickup_zone_id, tariff_id, quoted_fare_cents, quoted_distance_m,
          quoted_duration_s, surge_multiplier, payment_method,
          pool_mode, pool_trip_id, pool_preview_cents)
       VALUES (
          $20, $21,
          $1, $2, $3, $4::vehicle_category, 'requested',
          ST_SetSRID(ST_MakePoint($5, $6), 4326)::geography, $7,
          ST_SetSRID(ST_MakePoint($8, $9), 4326)::geography, $10,
          zone_for_point(ST_SetSRID(ST_MakePoint($5, $6), 4326)::geography),
          $11, $12, $13, $14, $15, $16::payment_method,
          $17, $18::uuid, $19)
       RETURNING *`,
      [
        reference,
        body.clientGeneratedId,
        riderId,
        body.category,
        body.pickup.lng,
        body.pickup.lat,
        body.pickup.address ?? null,
        body.dropoff.lng,
        body.dropoff.lat,
        body.dropoff.address ?? null,
        fare.tariffId,
        fare.totalFareCents,
        // From the server's own route lookup stored with the quote, never from
        // the client. Settlement falls back to this when the GPS trace is too
        // sparse, so leaving it empty billed such a trip at distance zero.
        Math.round(quotedInput?.distanceMetres ?? 0) || null,
        Math.round(quotedInput?.durationSeconds ?? 0) || null,
        fare.surgeMultiplier,
        body.paymentMethod,
        poolMode,
        body.poolTripId ?? null,
        poolMode && poolPreview ? poolPreview.sharedFareCents : null,
        passengerName,
        passengerPhone,
      ],
      );
    } catch (err: any) {
      // The one-own-ride-per-service rule. A second ride is fine when it is
      // booked for someone else; say so rather than returning a bare 500.
      if (err?.code === '23505' && String(err?.constraint ?? err?.message).includes('rides_one_active_own_per_service')) {
        throw new ConflictException('already_active_ride');
      }
      throw err;
    }

    return ride;
  }

  // ===================================================================
  // Dispatch orchestration
  // ===================================================================

  /**
   * Runs the offer loop. Called fire-and-forget from the gateway; progress
   * reaches the rider over `ride:status_change`, never over the HTTP reply.
   */
  async startDispatch(rideId: string): Promise<void> {
    const [ride] = await this.db.query(
      `SELECT id, rider_id, requested_category,
              ST_Y(pickup_point::geometry) AS lat,
              ST_X(pickup_point::geometry) AS lng,
              quoted_fare_cents, payment_method, status,
              pool_mode, pool_trip_id,
              ST_Y(dropoff_point::geometry) AS dlat,
              ST_X(dropoff_point::geometry) AS dlng
         FROM rides WHERE id = $1`,
      [rideId],
    );
    if (!ride || ride.status !== 'requested') return;

    // Subscribe the rider's live sockets to this ride's room.
    //
    // The WebSocket request path joins the room itself, but a ride created
    // over HTTP — which the web client and the mobile fallback both use —
    // never did. Every status update was then emitted to a room the rider was
    // not in, so the app sat on "requesting" forever while dispatch ran
    // normally in the background. socketsJoin reaches sockets on any node via
    // the Redis adapter, so this works with more than one replica.
    try {
      await this.gateway.server
        .in(`user:${ride.rider_id}`)
        .socketsJoin(`ride:${rideId}`);
    } catch (err) {
      this.logger.warn(
        `could not join rider to ride room ${rideId}: ${(err as Error).message}`,
      );
    }

    await this.db.query(`UPDATE rides SET status = 'searching' WHERE id = $1`, [rideId]);
    this.gateway.server.to(`ride:${rideId}`).emit('ride:status_change', {
      rideId,
      status: 'searching',
    });

    // Car pooling. 'match' first looks for a vehicle already on the road that
    // is going the same way; if none will take the rider, or the rider asked
    // to start a shared trip, they become the host of a new trip that others
    // can then join. Either way they carry on into ordinary dispatch below.
    if (ride.pool_mode === 'match' && !ride.pool_trip_id) {
      if (await this.tryLiveMatch(ride)) return;
    }
    if (ride.pool_mode && !ride.pool_trip_id) {
      ride.pool_trip_id = await this.pool.openTrip(rideId, ride.requested_category);
    }

    const declined: string[] = [];

    // Three passes. Between passes drivers move and new ones come online, so
    // a rider on a quiet street gets a second and third chance rather than an
    // immediate "no drivers".
    for (let pass = 0; pass < 3; pass++) {
      // The rider may have cancelled while an earlier pass was running.
      if (!(await this.stillSearching(rideId))) return;

      const candidates = await this.dispatch.findCandidates({
        rideId,
        riderId: ride.rider_id,
        category: ride.requested_category as VehicleCategory,
        pickup: { lat: Number(ride.lat), lng: Number(ride.lng) },
        excludeDriverIds: declined,
      });

      if (candidates.length === 0) {
        await this.sleep(4000);
        continue;
      }

      const offered: string[] = [];
      const winner = await this.dispatch.offerSequentially(
        {
          rideId,
          riderId: ride.rider_id,
          category: ride.requested_category as VehicleCategory,
          pickup: { lat: Number(ride.lat), lng: Number(ride.lng) },
          excludeDriverIds: declined,
        },
        candidates,
        (driverId, offer, ttl) => this.sendOffer(rideId, ride, driverId, offer, ttl),
        (rid, driverId, ttl) => this.awaitResponse(rid, driverId, ttl),
        offered,
      );

      if (winner) return;
      // Only drivers who really saw the offer are ruled out for later passes.
      // One that was busy with another offer at that instant gets another go.
      declined.push(...offered);
      if (offered.length === 0) await this.sleep(2500);
    }

    if (!(await this.stillSearching(rideId))) return;

    // Exhausted. Expire rather than leaving the ride open forever, and tell
    // the rider plainly so they can re-request or switch category.
    await this.db.query(
      `UPDATE rides SET status = 'expired', cancelled_at = now(),
              cancellation_reason = 'no_drivers_available'
        WHERE id = $1 AND status = 'searching'`,
      [rideId],
    );
    this.gateway.server.to(`ride:${rideId}`).emit('ride:status_change', {
      rideId,
      status: 'expired',
      reasonCode: 'no_drivers_available',
    });
    await this.onPoolRideEnded(rideId);
  }

  /**
   * Pushes an offer to one driver's personal room, with a signed token the
   * driver must return on accept. The token is what stops a driver from
   * claiming a ride id they were never offered.
   */
  private async sendOffer(
    rideId: string,
    ride: any,
    driverId: string,
    offer: ScoredDriver,
    ttlSeconds: number,
    poolInfo?: { detourM: number; coRiders: number },
  ): Promise<void> {
    const token = this.signOfferToken(rideId, driverId);
    await this.redis.set(`offer:${rideId}:${driverId}`, token, 'EX', ttlSeconds + 5);

    const [detail] = await this.db.query(
      `SELECT r.pickup_address, r.dropoff_address, r.quoted_fare_cents,
              ST_Y(r.pickup_point::geometry) AS plat, ST_X(r.pickup_point::geometry) AS plng,
              ST_Y(r.dropoff_point::geometry) AS dlat, ST_X(r.dropoff_point::geometry) AS dlng,
              r.quoted_distance_m, r.surge_multiplier, r.payment_method,
              u.rating_avg AS rider_rating,
              COALESCE(r.passenger_name, u.full_name) AS rider_name,
              u.photo_key AS rider_photo_key,
              (r.passenger_name IS NOT NULL) AS for_other,
              r.pool_mode, r.pool_preview_cents,
              t.commission_bps_cap
         FROM rides r
         JOIN users u ON u.id = r.rider_id
         LEFT JOIN tariffs t ON t.id = r.tariff_id
        WHERE r.id = $1`,
      [rideId],
    );

    // A pooled rider is shown the shared fare, which is what the driver can
    // expect when the car is shared; the full fare is only the ceiling.
    const isPool = Boolean(detail.pool_mode);
    const fare = isPool && detail.pool_preview_cents != null
      ? Number(detail.pool_preview_cents)
      : Number(detail.quoted_fare_cents);
    const coRiders = poolInfo?.coRiders ?? (isPool ? await this.pool.coRiders(rideId) : 0);
    // Fallback only — the live tariff is the source of truth. Kept in step
    // with the operator's standard rate so a missing tariff cannot quietly
    // show a driver a higher take-home than they will actually receive.
    const [freeWindow] = await this.db.query(
      `SELECT (commission_free_until IS NOT NULL AND commission_free_until > now()) AS free
         FROM drivers WHERE id = $1`,
      [driverId],
    );
    const commissionBps = freeWindow?.free ? 0 : Number(detail.commission_bps_cap ?? 1500);

    void this.pushDriverOffer(driverId, rideId);
    this.gateway.server.to(`driver:${driverId}`).emit('ride:request', {
      rideId,
      offerToken: token,
      expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
      ttlSeconds,
      pickupAddress: detail.pickup_address ?? 'Pickup point',
      dropoffAddress: detail.dropoff_address ?? 'Drop-off point',
      pickup: { lat: Number(detail.plat), lng: Number(detail.plng) },
      dropoff: { lat: Number(detail.dlat), lng: Number(detail.dlng) },
      distanceToPickupM: Math.round(offer.distanceM),
      etaToPickupSeconds: offer.etaSeconds,
      tripDistanceM: Number(detail.quoted_distance_m ?? 0),
      fareCents: fare,
      // Drivers care about take-home, not gross. Showing gross and letting
      // them discover the commission later is how you lose a fleet.
      driverEarningsCents: fare - Math.round((fare * commissionBps) / 10_000),
      surgeMultiplier: Number(detail.surge_multiplier),
      riderRating: Number(detail.rider_rating),
      riderName: detail.rider_name,
      riderPhotoUrl: !detail.for_other && detail.rider_photo_key
        ? `/api/photos/${detail.rider_photo_key}`
        : null,
      paymentMethod: detail.payment_method,
      isPool,
      // Riders already aboard (or waiting) on the trip this one would join.
      poolCoRiders: coRiders,
      poolDetourM: poolInfo?.detourM ?? 0,
    });
  }

  /**
   * Waits for the driver's answer. Resolution comes through a Redis key the
   * accept/decline handler sets — polling a local promise map would break the
   * moment the driver's socket lands on a different gateway node.
   */
  private async awaitResponse(
    rideId: string,
    driverId: string,
    ttlSeconds: number,
  ): Promise<'accepted' | 'declined' | 'timeout'> {
    const key = `offer:response:${rideId}:${driverId}`;
    const deadline = Date.now() + ttlSeconds * 1000;
    let nextStatusCheck = Date.now() + 1000;

    while (Date.now() < deadline) {
      const response = await this.redis.get(key);
      if (response === 'accepted' || response === 'declined') {
        await this.redis.del(key);
        return response;
      }
      // A rider who cancels mid-offer closes it at once; the driver should
      // not be left holding a request that no longer exists.
      if (Date.now() >= nextStatusCheck) {
        nextStatusCheck = Date.now() + 1000;
        const state = await this.searchState(rideId);
        if (state === 'claimed') return 'accepted'; // won a moment ago; the reply key is not set yet
        if (state === 'closed') {
          this.gateway.server
            .to(`driver:${driverId}`)
            .emit('ride:offer_closed', { rideId, reason: 'cancelled' });
          return 'declined';
        }
      }
      await this.sleep(250);
    }
    return 'timeout';
  }

  /** Where a ride stands while it is being offered around. */
  private async searchState(rideId: string): Promise<'open' | 'claimed' | 'closed'> {
    const [r] = await this.db.query(
      `SELECT status::text AS status, driver_id FROM rides WHERE id = $1`,
      [rideId],
    );
    if (!r) return 'closed';
    if (r.driver_id) return 'claimed';
    return ['requested', 'searching'].includes(r.status) ? 'open' : 'closed';
  }

  /** True while the ride is still waiting for a driver. */
  private async stillSearching(rideId: string): Promise<boolean> {
    return (await this.searchState(rideId)) === 'open';
  }

  // ===================================================================
  // Car pooling
  // ===================================================================

  /**
   * Tries to put a new pool rider on a vehicle that is already on the road.
   * Offers go to at most POOL.liveMatchOffers drivers, in best-fit order, so
   * a rider is never kept waiting long before falling back to a trip of their
   * own. Returns true when a driver accepted.
   */
  private async tryLiveMatch(ride: any): Promise<boolean> {
    let matches: TripMatch[] = [];
    try {
      matches = await this.pool.findLiveMatches(
        {
          riderId: ride.rider_id,
          category: ride.requested_category,
          pickup: { lat: Number(ride.lat), lng: Number(ride.lng) },
          dropoff: { lat: Number(ride.dlat), lng: Number(ride.dlng) },
        },
        POOL.liveMatchOffers,
      );
    } catch (err) {
      // A matching fault must never stop the rider from getting a car.
      this.logger.warn(`pool match failed ride=${ride.id}: ${(err as Error).message}`);
      return false;
    }

    for (const m of matches) {
      if (!(await this.stillSearching(ride.id))) return true;
      if (await this.offerPoolSeat(ride, m)) return true;
    }
    return false;
  }

  /** One pool offer to the driver already running this trip. */
  private async offerPoolSeat(ride: any, m: TripMatch): Promise<boolean> {
    const driverId = m.trip.driverId!;
    // Remembered so `claim` knows which trip the rider is joining.
    await this.redis.set(`pool:offer:${ride.id}:${driverId}`, m.trip.id, 'EX', 60);

    const candidate: ScoredDriver = {
      driverId,
      vehicleId: '',
      distanceM: m.verdict.toPickupM,
      etaSeconds: Math.round((m.verdict.toPickupM * 1.35) / 4),
      score: 0,
      acceptanceRate: 1,
      rating: 5,
    };
    const offerOnce = () =>
      this.dispatch.offerToDriver(
        ride.id,
        candidate,
        (d, o, ttl) =>
          this.sendOffer(ride.id, ride, d, o, ttl, {
            detourM: m.verdict.detourM,
            coRiders: m.trip.riders.length,
          }),
        (rid, d, ttl) => this.awaitResponse(rid, d, ttl),
      );

    // The driver may be mid-offer for a moment; a short wait beats dropping a
    // good match.
    let outcome = await offerOnce();
    for (let i = 0; outcome === 'busy' && i < 3; i++) {
      await this.sleep(1000);
      outcome = await offerOnce();
    }

    await this.redis.del(`pool:offer:${ride.id}:${driverId}`);
    return outcome === 'accepted';
  }

  /**
   * A rider chose a specific shared trip from the list whose vehicle is
   * already on the road. The driver is asked; if they decline or do not
   * answer, the rider starts a shared trip of their own instead of being
   * left without a car. (A trip still waiting for its first driver needs no
   * offer: its riders are given the driver the host is given, see `claim`.)
   */
  async startPoolJoin(rideId: string, tripId: string): Promise<void> {
    const [ride] = await this.db.query(
      `SELECT id, rider_id, requested_category, status, pool_trip_id,
              ST_Y(pickup_point::geometry) AS lat, ST_X(pickup_point::geometry) AS lng,
              ST_Y(dropoff_point::geometry) AS dlat, ST_X(dropoff_point::geometry) AS dlng
         FROM rides WHERE id = $1`,
      [rideId],
    );
    if (!ride || ride.status !== 'requested') return;

    // Any waiting-seat link is dropped: from here the rider is offered to the
    // driver as a newcomer and is linked only when the driver accepts.
    await this.db.query(
      `UPDATE rides SET pool_trip_id = NULL WHERE id = $1 AND driver_id IS NULL`,
      [rideId],
    );
    await this.joinRiderRoom(ride.rider_id, rideId);
    this.gateway.server.to(`ride:${rideId}`).emit('ride:status_change', {
      rideId, status: 'searching',
    });

    const match = await this.pool.checkJoin(tripId, {
      riderId: ride.rider_id,
      category: ride.requested_category,
      pickup: { lat: Number(ride.lat), lng: Number(ride.lng) },
      dropoff: { lat: Number(ride.dlat), lng: Number(ride.dlng) },
    });

    if (match && match.trip.driverId && (await this.offerPoolSeat(ride, match))) return;
    if (!(await this.stillSearching(rideId))) return;

    // Declined, timed out, or the trip filled / moved on. Carry on alone.
    await this.db.query(
      `UPDATE rides SET status = 'requested', pool_mode = 'host', pool_trip_id = NULL
        WHERE id = $1 AND driver_id IS NULL AND status IN ('requested','searching')`,
      [rideId],
    );
    void this.startDispatch(rideId).catch((err) =>
      this.logger.error(`dispatch failed ride=${rideId}: ${err.message}`));
  }

  /** Subscribes a rider's live sockets to their ride's room. */
  async joinRiderRoom(riderId: string, rideId: string): Promise<void> {
    try {
      await this.gateway.server.in(`user:${riderId}`).socketsJoin(`ride:${rideId}`);
    } catch (err) {
      this.logger.warn(`could not join rider to ride room ${rideId}: ${(err as Error).message}`);
    }
  }

  /** Tells everyone on a trip how many others are now sharing it. */
  async broadcastPoolCount(tripId: string): Promise<void> {
    const ids = await this.pool.activeRideIds(tripId);
    for (const id of ids) {
      this.gateway.server.to(`ride:${id}`).emit('ride:pool_update', {
        rideId: id,
        coRiders: ids.length - 1,
      });
    }
  }

  /**
   * What the driver's app needs to show one more rider on the trip.
   * Names and areas only; the rider's number stays behind the contact sheet.
   */
  async poolRiderPayload(rideId: string) {
    const [r] = await this.db.query(
      `SELECT r.id, r.status::text AS status, r.payment_method, r.pickup_address,
              r.dropoff_address, r.quoted_fare_cents, r.pool_preview_cents,
              ST_Y(r.pickup_point::geometry) AS plat, ST_X(r.pickup_point::geometry) AS plng,
              ST_Y(r.dropoff_point::geometry) AS dlat, ST_X(r.dropoff_point::geometry) AS dlng,
              COALESCE(r.passenger_name, u.full_name) AS full_name,
              (r.passenger_name IS NOT NULL) AS for_other,
              u.photo_key, u.rating_avg
         FROM rides r JOIN users u ON u.id = r.rider_id
        WHERE r.id = $1`,
      [rideId],
    );
    if (!r) return null;
    return {
      rideId: r.id,
      status: r.status,
      riderName: r.full_name,
      riderRating: Number(r.rating_avg),
      // A ride booked for someone else shows that person's name, not the
      // booker's photo or rating.
      riderPhotoUrl: !r.for_other && r.photo_key ? `/api/photos/${r.photo_key}` : null,
      pickupAddress: r.pickup_address ?? '',
      dropoffAddress: r.dropoff_address ?? '',
      pickup: { lat: Number(r.plat), lng: Number(r.plng) },
      dropoff: { lat: Number(r.dlat), lng: Number(r.dlng) },
      fareCents: Number(r.pool_preview_cents ?? r.quoted_fare_cents ?? 0),
      paymentMethod: r.payment_method,
    };
  }

  /**
   * Driver state follows the whole set of rides they are carrying, not the
   * last thing that happened. With one rider this is identical to the old
   * behaviour; with several, completing one rider must not mark the driver
   * idle while another is still aboard.
   */
  private async refreshDriverState(driverId: string): Promise<void> {
    const [row] = await this.db.query(
      `UPDATE drivers d SET state = (
         CASE
           WHEN EXISTS (SELECT 1 FROM rides r WHERE r.driver_id = d.id AND r.status = 'in_progress')
             THEN 'on_trip'
           WHEN EXISTS (SELECT 1 FROM rides r WHERE r.driver_id = d.id AND r.status = 'arrived')
             THEN 'at_pickup'
           WHEN EXISTS (SELECT 1 FROM rides r WHERE r.driver_id = d.id AND r.status = 'accepted')
             THEN 'en_route_pickup'
           ELSE 'online_idle'
         END)::driver_state
       WHERE d.id = $1
       RETURNING d.state::text AS state`,
      [driverId],
    );
    // Dispatch reads the Redis snapshot, so it must never lag the database:
    // a driver who has just taken a rider must stop being offered others.
    if (row) await this.redis.hset(`driver:${driverId}`, 'state', row.state);
  }

  /**
   * Housekeeping when a pool ride ends any way other than completing:
   * hand the trip to the next waiting rider if the host left before a driver
   * was found, and close the trip when nobody is left on it.
   */
  private async onPoolRideEnded(rideId: string): Promise<void> {
    const [r] = await this.db.query(
      `SELECT pool_trip_id, driver_id FROM rides WHERE id = $1`,
      [rideId],
    );
    if (!r?.pool_trip_id) return;
    if (r.driver_id) await this.redis.srem(`pool:driver:${r.driver_id}:rides`, rideId);

    const next = await this.pool.promoteHost(r.pool_trip_id, rideId);
    if (next) {
      this.logger.log(`pool trip ${r.pool_trip_id}: ride ${next} is now the host`);
      void this.startDispatch(next).catch((err) =>
        this.logger.error(`dispatch failed ride=${next}: ${err.message}`));
    }
    await this.pool.closeIfDone(r.pool_trip_id);
    await this.broadcastPoolCount(r.pool_trip_id);
  }

  // ===================================================================
  // Claiming
  // ===================================================================

  /**
   * Atomic claim. The conditional UPDATE is the entire concurrency control:
   * whichever driver's statement lands first sets driver_id, and the second
   * updates zero rows and is told the ride was taken.
   */
  async claim(rideId: string, driverId: string, offerToken: string) {
    const expected = await this.redis.get(`offer:${rideId}:${driverId}`);
    if (!expected || expected !== offerToken) {
      this.logger.warn(`rejected claim ride=${rideId} driver=${driverId}: bad offer token`);
      return null;
    }

    // A pool rider joining a vehicle already on the road was offered to this
    // driver for a specific trip; the link is made here, in the same
    // statement that assigns the driver.
    const joinTripId = await this.redis.get(`pool:offer:${rideId}:${driverId}`);

    const [claimed] = await this.db.query(
      `UPDATE rides r
          SET driver_id = $2,
              vehicle_id = d.active_vehicle_id,
              status = 'accepted',
              accepted_at = now(),
              pool_trip_id = COALESCE(r.pool_trip_id, $3::uuid)
         FROM drivers d
        WHERE r.id = $1
          AND d.id = $2
          AND r.driver_id IS NULL
          AND r.status IN ('requested', 'searching')
        RETURNING r.id, r.pool_trip_id, r.pool_mode`,
      [rideId, driverId, joinTripId],
    );

    if (!claimed) return null;

    await this.redis.set(`offer:response:${rideId}:${driverId}`, 'accepted', 'EX', 30);

    // Pooling: the first rider's driver becomes the trip's driver, and anyone
    // who joined the trip while it was still waiting gets that driver too.
    let pooledRideIds: string[] = [];
    let joinedExisting = false;
    if (claimed.pool_trip_id) {
      const [tripDriver] = await this.db.query(
        `UPDATE pool_trips SET driver_id = $2
          WHERE id = $1 AND driver_id IS NULL RETURNING id`,
        [claimed.pool_trip_id, driverId],
      );
      if (tripDriver) {
        const attached = await this.db.query(
          `UPDATE rides r
              SET driver_id = $2, vehicle_id = d.active_vehicle_id,
                  status = 'accepted', accepted_at = now()
             FROM drivers d
            WHERE r.pool_trip_id = $1 AND r.id <> $3 AND d.id = $2
              AND r.driver_id IS NULL AND r.status = 'requested'
            RETURNING r.id`,
          [claimed.pool_trip_id, driverId, rideId],
        );
        pooledRideIds = attached.map((a: any) => a.id);
      } else {
        joinedExisting = true;
      }
      const key = `pool:driver:${driverId}:rides`;
      await this.redis.sadd(key, rideId, ...pooledRideIds);
      await this.redis.expire(key, 6 * 3600);
      await this.redis.del(`pool:offer:${rideId}:${driverId}`);
    }

    await this.refreshDriverState(driverId);
    // Out of the idle pool until the trip ends.
    const [driver] = await this.db.query(
      `SELECT v.category FROM drivers d JOIN vehicles v ON v.id = d.active_vehicle_id
        WHERE d.id = $1`,
      [driverId],
    );
    if (driver) {
      await this.dispatch.removeDriverFromPool(driverId, driver.category);
    }

    const [profile] = await this.db.query(
      `SELECT u.full_name, u.rating_avg, u.phone, u.photo_key,
              d.completed_trips,
              v.plate_number, v.make, v.model, v.colour, v.category
         FROM drivers d
         JOIN users u ON u.id = d.user_id
         JOIN vehicles v ON v.id = d.active_vehicle_id
        WHERE d.id = $1`,
      [driverId],
    );

    return {
      driverPublicProfile: {
        name: profile.full_name,
        // Required by An operator-licence app test may: the rider must be
        // able to see the driver's name and photo.
        photoUrl: profile.photo_key ? `/api/photos/${profile.photo_key}` : null,
        rating: Number(profile.rating_avg),
        trips: Number(profile.completed_trips),
        // Masked behind a voice proxy in production; the raw number is never
        // handed to the rider.
        phoneMasked: this.maskPhone(profile.phone),
      },
      vehicle: {
        plate: profile.plate_number,
        make: profile.make,
        model: profile.model,
        colour: profile.colour,
        category: profile.category,
      },
      etaSeconds: 0,
      pool: claimed.pool_trip_id
        ? {
            tripId: claimed.pool_trip_id as string,
            // Riders attached to this driver by the same acceptance.
            attachedRideIds: pooledRideIds,
            // True when this rider joined a vehicle that already had riders.
            joinedExisting,
          }
        : null,
    };
  }

  async declineOffer(rideId: string, driverId: string, reason?: string): Promise<void> {
    await this.redis.set(`offer:response:${rideId}:${driverId}`, 'declined', 'EX', 30);
    await this.db.query(
      `UPDATE ride_offers SET responded_at = now(), outcome = 'declined'
        WHERE ride_id = $1 AND driver_id = $2 AND outcome IS NULL`,
      [rideId, driverId],
    );
    if (reason) this.logger.debug(`decline ride=${rideId} driver=${driverId}: ${reason}`);
  }

  // ===================================================================
  // Transitions
  // ===================================================================

  /**
   * Validates and applies a status transition. A replayed 'completed' after a
   * reconnect must not close a trip twice or charge twice, so every
   * transition is guarded by the current status in the WHERE clause.
   */
  async transition(
    rideId: string,
    driverId: string,
    status: 'arrived' | 'in_progress' | 'completed',
    at: Date,
  ) {
    const allowedFrom: Record<string, string[]> = {
      arrived: ['accepted'],
      in_progress: ['accepted', 'arrived'],
      completed: ['in_progress'],
    };

    if (status !== 'completed') {
      const column = status === 'arrived' ? 'arrived_at' : 'started_at';
      const [row] = await this.db.query(
        `UPDATE rides SET status = $3::ride_status, ${column} = $4
          WHERE id = $1 AND driver_id = $2 AND status = ANY($5::ride_status[])
          RETURNING *`,
        [rideId, driverId, status, at, allowedFrom[status]],
      );
      if (!row) throw new BadRequestException('invalid_transition');

      await this.refreshDriverState(driverId);
      return this.rowToRide(row);
    }

    return this.complete(rideId, driverId, at);
  }

  /**
   * Closes the trip and settles the fare. Distance comes from the breadcrumb
   * trail in PostGIS, not from the device.
   */
  private async complete(rideId: string, driverId: string, at: Date) {
    const [ride] = await this.db.query(
      `SELECT r.*, ST_Y(r.pickup_point::geometry) AS pickup_lat,
              ST_X(r.pickup_point::geometry) AS pickup_lng
         FROM rides r
        WHERE r.id = $1 AND r.driver_id = $2 AND r.status = 'in_progress'`,
      [rideId, driverId],
    );
    if (!ride) throw new BadRequestException('invalid_transition');

    // ST_Length over the ordered breadcrumb line gives the driven distance.
    // Falling back to the quote when the trace is too sparse is deliberate:
    // a GPS outage should not produce a near-zero fare for a 12 km trip.
    // Pings still waiting in this node's buffer belong to this trip.
    await this.flushBreadcrumbs();

    // A pooled rider's distance is what the vehicle covered while they were
    // aboard. Breadcrumbs are tagged with a single ride id, so for a shared
    // vehicle the trace is read by driver and time window instead.
    const isPool = Boolean(ride.pool_trip_id);
    const [measured] = isPool
      ? await this.db.query(
          `SELECT
             COALESCE(ST_Length(ST_MakeLine(position::geometry ORDER BY recorded_at)::geography), 0) AS distance_m,
             COUNT(*) AS points
           FROM locations
          WHERE driver_id = $1 AND recorded_at >= $2 AND recorded_at <= $3`,
          [driverId, ride.started_at, at],
        )
      : await this.db.query(
          `SELECT
             COALESCE(ST_Length(ST_MakeLine(position::geometry ORDER BY recorded_at)::geography), 0) AS distance_m,
             COUNT(*) AS points
           FROM locations
          WHERE ride_id = $1`,
          [rideId],
        );

    const tracedDistance = Number(measured?.distance_m ?? 0);
    const enoughPoints = Number(measured?.points ?? 0) >= 5;
    const distanceM = enoughPoints && tracedDistance > 0
      ? Math.round(tracedDistance)
      : Number(ride.quoted_distance_m ?? 0);

    const durationS = Math.max(
      0,
      Math.round((at.getTime() - new Date(ride.started_at).getTime()) / 1000),
    );

    // The pool discount is earned, not promised: it applies only for the
    // riders who were really on board together. Other riders count if their
    // time aboard overlapped this one's at any point.
    let sharedWith = 0;
    if (isPool) {
      const [overlap] = await this.db.query(
        `SELECT COUNT(*)::int AS n FROM rides o
          WHERE o.pool_trip_id = $1 AND o.id <> $2
            AND o.started_at IS NOT NULL
            AND o.status IN ('in_progress', 'completed')
            AND o.started_at < $3
            AND COALESCE(o.completed_at, $3) > $4`,
        [ride.pool_trip_id, rideId, at, ride.started_at],
      );
      sharedWith = Number(overlap?.n ?? 0);
    }
    const poolDiscountBps = discountBpsFor(sharedWith);

    // New drivers keep the whole fare during their commission-free window.
    const [freeWindow] = await this.db.query(
      `SELECT (commission_free_until IS NOT NULL AND commission_free_until > $2) AS free
         FROM drivers WHERE id = $1`,
      [driverId, at],
    );
    const commissionFree = Boolean(freeWindow?.free);

    const { fare, needsReview } = await this.fares.settle(
      {
        category: ride.requested_category,
        distanceMetres: distanceM,
        durationSeconds: durationS,
        waitingSeconds: ride.waiting_seconds ?? 0,
        pickup: { lat: Number(ride.pickup_lat), lng: Number(ride.pickup_lng) },
        lockedSurge: Number(ride.surge_multiplier),
        poolDiscountBps,
        commissionFree,
      },
      Number(ride.quoted_fare_cents),
    );

    const [updated] = await this.db.query(
      `UPDATE rides
          SET status = 'completed',
              completed_at = $2,
              actual_distance_m = $3,
              actual_duration_s = $4,
              final_fare_cents = $5,
              commission_cents = $6,
              booking_fee_cents = $7,
              vat_cents = $8,
              driver_earnings_cents = $9,
              pool_discount_bps = $10,
              pool_discount_cents = $11,
              pool_shared_with = $12
        WHERE id = $1
        RETURNING *`,
      [
        rideId,
        at,
        distanceM,
        durationS,
        fare.totalFareCents,
        fare.commissionCents,
        fare.bookingFeeCents,
        fare.vatOnCommissionCents,
        fare.driverEarningsCents,
        poolDiscountBps,
        fare.poolDiscountCents,
        sharedWith,
      ],
    );

    // Cash trips: the driver already holds the money, so the commission
    // becomes a debt against their wallet. Past the floor they stop getting
    // offers until they settle.
    if (ride.payment_method === 'cash') {
      await this.db.query(
        `UPDATE drivers
            SET wallet_balance_cents = wallet_balance_cents - $2,
                completed_trips = completed_trips + 1
          WHERE id = $1`,
        [driverId, fare.commissionCents],
      );
    } else {
      await this.db.query(
        `UPDATE drivers SET completed_trips = completed_trips + 1 WHERE id = $1`,
        [driverId],
      );
    }
    await this.refreshDriverState(driverId);

    if (isPool) {
      await this.redis.srem(`pool:driver:${driverId}:rides`, rideId);
      await this.pool.closeIfDone(ride.pool_trip_id);
      await this.broadcastPoolCount(ride.pool_trip_id);
    }

    if (needsReview) {
      this.logger.warn(`ride ${rideId} settled above quote tolerance — flagged for review`);
    }

    return this.rowToRide(updated);
  }

  async cancel(rideId: string, byUserId: string, reason?: string) {
    const [ride] = await this.db.query(
      `SELECT r.*, ST_Y(r.pickup_point::geometry) AS lat,
              ST_X(r.pickup_point::geometry) AS lng
         FROM rides r WHERE r.id = $1`,
      [rideId],
    );
    if (!ride) throw new BadRequestException('ride_not_found');

    const byRider = ride.rider_id === byUserId;
    const secondsSinceAccept = ride.accepted_at
      ? (Date.now() - new Date(ride.accepted_at).getTime()) / 1000
      : 0;

    const feeCents = byRider
      ? await this.fares.cancellationFee(
          ride.requested_category,
          { lat: Number(ride.lat), lng: Number(ride.lng) },
          secondsSinceAccept,
          Boolean(ride.arrived_at),
        )
      : 0;

    await this.db.query(
      `UPDATE rides
          SET status = $2::ride_status, cancelled_at = now(),
              cancellation_reason = $3, final_fare_cents = $4
        WHERE id = $1 AND status NOT IN ('completed', 'cancelled_by_rider', 'cancelled_by_driver')`,
      [
        rideId,
        byRider ? 'cancelled_by_rider' : 'cancelled_by_driver',
        reason ?? null,
        feeCents || null,
      ],
    );

    if (ride.driver_id) await this.refreshDriverState(ride.driver_id);

    this.gateway.server.to(`ride:${rideId}`).emit('ride:status_change', {
      rideId,
      status: byRider ? 'cancelled_by_rider' : 'cancelled_by_driver',
      cancellationFeeCents: feeCents,
    });
    await this.onPoolRideEnded(rideId);

    return { cancelled: true, feeCents };
  }

  // ===================================================================
  // Ratings
  // ===================================================================

  /**
   * Records a one-to-five star rating and updates the recipient's average.
   *
   * Column meaning, since the names invite confusion:
   *   rides.driver_rating = the stars the RIDER gave the DRIVER
   *   rides.rider_rating  = the stars the DRIVER gave the RIDER
   *
   * The caller's role is derived from the ride, never trusted from the
   * request, so neither party can rate themselves.
   *
   * The average is derived from an integer sum rather than updated in place,
   * so it stays exact no matter how many trips a driver completes.
   */
  async rate(
    rideId: string,
    raterUserId: string,
    stars: number,
    comment?: string,
  ) {
    const [ride] = await this.db.query(
      `SELECT r.id, r.status, r.rider_id, r.driver_id,
              r.rider_rating, r.driver_rating,
              d.user_id AS driver_user_id
         FROM rides r
         LEFT JOIN drivers d ON d.id = r.driver_id
        WHERE r.id = $1`,
      [rideId],
    );

    if (!ride) throw new BadRequestException('ride_not_found');
    if (ride.status !== 'completed') {
      throw new BadRequestException('ride is not complete');
    }

    const isRider = ride.rider_id === raterUserId;
    const isDriver = ride.driver_user_id === raterUserId;
    if (!isRider && !isDriver) throw new BadRequestException('not_your_ride');

    // Column the rating lands in, and whose average it moves.
    const column = isRider ? 'driver_rating' : 'rider_rating';
    const recipientUserId = isRider ? ride.driver_user_id : ride.rider_id;
    if (!recipientUserId) throw new BadRequestException('no_counterparty');

    // Ratings are final. Allowing a re-rate invites pressure on the driver to
    // ask a rider to change it.
    if (ride[column] != null) {
      return { alreadyRated: true, stars: Number(ride[column]) };
    }

    await this.db.transaction(async (manager) => {
      await manager.query(
        `UPDATE rides SET ${column} = $2 WHERE id = $1`,
        [rideId, stars],
      );

      // The average is DERIVED from the integer sum, never updated in place.
      // Updating a rounded average on every rating accumulated up to 0.10
      // stars of drift in simulation, which matters when drivers are
      // deactivated on rating thresholds.
      await manager.query(
        `UPDATE users
            SET rating_sum = rating_sum + $2,
                rating_count = rating_count + 1,
                rating_avg = round(
                  (rating_sum + $2)::numeric / (rating_count + 1), 2)
          WHERE id = $1`,
        [recipientUserId, stars],
      );
    });

    if (comment && comment.trim().length > 0) {
      this.logger.log(`rating comment ride=${rideId} stars=${stars}`);
    }

    return { rated: true, stars };
  }

  // ===================================================================
  // Breadcrumbs
  // ===================================================================

  /**
   * Buffers in memory and flushes in batches. One INSERT per ping would put
   * thousands of tiny writes per second on the primary; batching turns that
   * into a handful of multi-row inserts.
   */
  async enqueueBreadcrumb(input: BreadcrumbInput): Promise<void> {
    this.breadcrumbBuffer.push(input);
    if (this.breadcrumbBuffer.length >= 200) await this.flushBreadcrumbs();
  }

  async flushBreadcrumbs(): Promise<void> {
    if (this.breadcrumbBuffer.length === 0) return;

    const batch = this.breadcrumbBuffer;
    this.breadcrumbBuffer = [];

    // Every placeholder is typed. Without the casts Postgres sees untyped
    // text in a VALUES list and refuses to put it in uuid / smallint columns,
    // which made every flush fail and left the locations table empty.
    const values = batch
      .map(
        (_, i) =>
          `($${i * 9 + 1}::uuid, $${i * 9 + 2}::uuid, ` +
          `ST_SetSRID(ST_MakePoint($${i * 9 + 3}::float8, $${i * 9 + 4}::float8), 4326)::geography, ` +
          `ROUND($${i * 9 + 5}::numeric)::smallint, ROUND($${i * 9 + 6}::numeric)::smallint, ` +
          `ROUND($${i * 9 + 7}::numeric)::smallint, $${i * 9 + 8}::timestamptz, $${i * 9 + 9}::boolean)`,
      )
      .join(', ');

    const params = batch.flatMap((b) => [
      b.driverId,
      b.rideId,
      b.lng,
      b.lat,
      b.headingDeg,
      b.speedKph,
      b.accuracyM,
      b.recordedAt,
      b.isBackfilled,
    ]);

    try {
      await this.db.query(
        `INSERT INTO locations
           (driver_id, ride_id, position, heading_deg, speed_kph, accuracy_m, recorded_at, is_backfilled)
         VALUES ${values}`,
        params,
      );
    } catch (err) {
      // Losing breadcrumbs degrades the trip trace but must never break the
      // socket path, so this is logged rather than thrown.
      this.logger.error(`breadcrumb flush failed (${batch.length} rows): ${(err as Error).message}`);
    }
  }

  // ===================================================================
  // Reads
  // ===================================================================

  /**
   * Rides a driver is carrying right now, shaped for the driver app. Lets the
   * app pick the trip back up after a restart or a dropped connection instead
   * of showing an empty screen with a rider waiting.
   */
  async findActiveForDriverUser(userId: string) {
    const rows = await this.db.query(
      `SELECT r.id FROM rides r JOIN drivers d ON d.id = r.driver_id
        WHERE d.user_id = $1 AND r.status IN ('accepted','arrived','in_progress')
        ORDER BY r.requested_at ASC`,
      [userId],
    );
    const out = [];
    for (const r of rows) {
      const p = await this.poolRiderPayload(r.id);
      if (p) out.push(p);
    }
    return out;
  }


  /**
   * Everything the rider's screen needs about every ride they have open: the
   * driver's name, photo and rating, the vehicle (make, model, colour, plate),
   * where the driver is right now, and who the ride is for. The rider app and
   * the web page both poll this as a safety net behind the live socket, so a
   * missed event never leaves a rider staring at "searching" after a driver
   * has accepted.
   */
  async trackingForRider(userId: string) {
    const rows = await this.db.query(
      `SELECT r.id, r.reference, r.status::text AS status,
              r.requested_category::text AS category, r.service_type::text AS service_type,
              r.quoted_fare_cents, r.final_fare_cents, r.payment_method::text AS payment_method,
              r.is_paid, r.pickup_address, r.dropoff_address,
              r.passenger_name, r.passenger_phone, r.pool_mode, r.driver_id,
              ST_Y(r.pickup_point::geometry) AS plat, ST_X(r.pickup_point::geometry) AS plng,
              ST_Y(r.dropoff_point::geometry) AS dlat, ST_X(r.dropoff_point::geometry) AS dlng,
              r.accepted_at, r.arrived_at, r.started_at, r.requested_at,
              u.full_name AS driver_name, u.photo_key AS driver_photo, u.rating_avg AS driver_rating,
              d.completed_trips,
              v.plate_number, v.make, v.model, v.colour, v.category::text AS vehicle_category
         FROM rides r
         LEFT JOIN drivers d ON d.id = r.driver_id
         LEFT JOIN users u ON u.id = d.user_id
         LEFT JOIN vehicles v ON v.id = d.active_vehicle_id
        WHERE r.rider_id = $1
          AND ( r.status IN ('requested','searching','accepted','arrived','in_progress')
                OR (r.status = 'completed' AND r.completed_at > now() - interval '30 minutes') )
        ORDER BY r.requested_at ASC`,
      [userId],
    );

    const out = [];
    for (const r of rows) {
      let driverPosition: any = null;
      if (r.driver_id && ['accepted', 'arrived', 'in_progress'].includes(r.status)) {
        const h = await this.redis.hmget(`driver:${r.driver_id}`, 'lat', 'lng', 'heading', 'lastPingAt');
        if (h[0] && h[1]) {
          driverPosition = { lat: Number(h[0]), lng: Number(h[1]), heading: Number(h[2] ?? 0), at: Number(h[3] ?? 0) };
        }
      }
      out.push({
        rideId: r.id,
        reference: r.reference,
        status: r.status,
        category: r.category,
        serviceType: r.service_type,
        quotedFareCents: Number(r.quoted_fare_cents ?? 0),
        finalFareCents: r.final_fare_cents == null ? null : Number(r.final_fare_cents),
        paymentMethod: r.payment_method,
        isPaid: Boolean(r.is_paid),
        pickupAddress: r.pickup_address ?? '',
        dropoffAddress: r.dropoff_address ?? '',
        pickup: { lat: Number(r.plat), lng: Number(r.plng) },
        dropoff: { lat: Number(r.dlat), lng: Number(r.dlng) },
        passengerName: r.passenger_name ?? null,
        forOther: Boolean(r.passenger_name),
        poolMode: r.pool_mode ?? null,
        driver: r.driver_id
          ? {
              name: r.driver_name,
              photoUrl: r.driver_photo ? `/api/photos/${r.driver_photo}` : null,
              rating: Number(r.driver_rating ?? 5),
              trips: Number(r.completed_trips ?? 0),
              phoneMasked: '',
            }
          : null,
        vehicle: r.driver_id
          ? {
              plate: r.plate_number,
              make: r.make,
              model: r.model,
              colour: r.colour,
              category: r.vehicle_category,
            }
          : null,
        driverPosition,
        arrivedAt: r.arrived_at,
      });
    }
    return out;
  }

  async openRideIdsForDriver(driverId: string): Promise<string[]> {
    const rows = await this.db.query(
      `SELECT id FROM rides WHERE driver_id = $1
          AND status IN ('accepted','arrived','in_progress')`,
      [driverId],
    );
    return rows.map((r: any) => r.id);
  }

  async findActiveForUser(userId: string) {
    const rows = await this.db.query(
      `SELECT r.* FROM rides r
         LEFT JOIN drivers d ON d.id = r.driver_id
        WHERE (r.rider_id = $1 OR d.user_id = $1)
          AND r.status IN ('requested','searching','accepted','arrived','in_progress')
        ORDER BY r.requested_at DESC`,
      [userId],
    );
    return rows.map((r: any) => this.rowToRide(r));
  }

  async history(userId: string, limit = 20, offset = 0) {
    return this.db.query(
      `SELECT r.id, r.reference, r.status, r.requested_at, r.completed_at,
              r.pickup_address, r.dropoff_address, r.final_fare_cents,
              r.requested_category, r.payment_method
         FROM rides r
         LEFT JOIN drivers d ON d.id = r.driver_id
        WHERE r.rider_id = $1 OR d.user_id = $1
        ORDER BY r.requested_at DESC
        LIMIT $2 OFFSET $3`,
      [userId, Math.min(limit, 100), offset],
    );
  }

  toWireSummary(ride: any) {
    return {
      rideId: ride.id,
      reference: ride.reference,
      status: ride.status,
      category: ride.requestedCategory ?? ride.requested_category,
      quotedFareCents: Number(ride.quotedFareCents ?? ride.quoted_fare_cents ?? 0),
      finalFareCents: ride.finalFareCents ?? ride.final_fare_cents ?? null,
      paymentMethod: ride.paymentMethod ?? ride.payment_method,
      isPaid: ride.isPaid ?? ride.is_paid ?? false,
      pool: (ride.pool_mode ?? ride.poolMode)
        ? {
            mode: ride.pool_mode ?? ride.poolMode,
            previewCents: ride.pool_preview_cents != null ? Number(ride.pool_preview_cents) : null,
            discountBps: Number(ride.pool_discount_bps ?? 0),
            discountCents: Number(ride.pool_discount_cents ?? 0),
            sharedWith: Number(ride.pool_shared_with ?? 0),
          }
        : null,
      at: Date.now(),
    };
  }

  private rowToRide(row: any) {
    return {
      ...row,
      id: row.id,
      finalFareCents: row.final_fare_cents ? Number(row.final_fare_cents) : null,
      actualDistanceM: row.actual_distance_m,
      actualDurationS: row.actual_duration_s,
      paymentMethod: row.payment_method,
    };
  }

  // ===================================================================
  // Helpers
  // ===================================================================

  /** Human-readable, unambiguous over a phone line: no O/0 or I/1 confusion. */
  private generateReference(): string {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += alphabet[crypto.randomInt(0, alphabet.length)];
    }
    return `${country.code}-${code}`;
  }

  private signOfferToken(rideId: string, driverId: string): string {
    return crypto
      .createHmac('sha256', process.env.OFFER_TOKEN_SECRET ?? process.env.JWT_ACCESS_SECRET ?? 'dev')
      .update(`${rideId}:${driverId}:${Math.floor(Date.now() / 1000)}`)
      .digest('base64url');
  }

  private maskPhone(phone: string): string {
    return maskPhone(phone);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
