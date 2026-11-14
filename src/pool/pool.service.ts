/**
 * PoolService — data and matching for shared (pooled) trips.
 *
 * Model
 *   A pool trip is one vehicle journey. Each rider on it has an ordinary
 *   `rides` row linked by `pool_trip_id`, so everything downstream (payments,
 *   commission, cash debt, ratings, SOS, messages) is per rider and unchanged.
 *
 * Two ways onto a trip
 *   live match   a new rider is tried against vehicles already on the road
 *                (driver position from Redis, route from the riders aboard);
 *                if none fits, they start a trip of their own.
 *   shared trip  a rider starts a trip on purpose, and others browse and join
 *                it, before or after a driver has been found.
 *
 * This service never talks to sockets and never calls RidesService; it only
 * reads and writes pool data. RidesService owns the ride lifecycle and calls
 * in here, which keeps the dependency one-way.
 */

import { Injectable, Inject, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import Redis from 'ioredis';

import { REDIS } from '../common/redis.module';
import { POOL, poolSeatsFor } from './pool.config';
import { Pt, RouteRef, MatchVerdict, evaluateMatch, haversineM } from './pool.geo';

const ACTIVE = `('requested','searching','accepted','arrived','in_progress')`;

export interface TripRider {
  rideId: string;
  riderId: string;
  status: string;
  riderName: string | null;
  pickup: Pt;
  dropoff: Pt;
  pickupAddress: string | null;
  dropoffAddress: string | null;
}

export interface TripSnapshot {
  id: string;
  category: string;
  driverId: string | null;
  seatsTotal: number;
  hostRideId: string | null;
  riders: TripRider[];
  seatsLeft: number;
  route: RouteRef | null;
}

export interface TripMatch {
  trip: TripSnapshot;
  verdict: MatchVerdict;
}

export interface JoinerRoute {
  riderId: string;
  category: string;
  pickup: Pt;
  dropoff: Pt;
}

@Injectable()
export class PoolService {
  private readonly logger = new Logger(PoolService.name);

  constructor(
    private readonly db: DataSource,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  // =====================================================================
  // Trip lifecycle
  // =====================================================================

  /** Starts a trip with this ride as its host and links the ride to it. */
  async openTrip(rideId: string, category: string): Promise<string> {
    const [trip] = await this.db.query(
      `INSERT INTO pool_trips (category, host_ride_id, seats_total)
       VALUES ($1::vehicle_category, $2, $3)
       RETURNING id`,
      [category, rideId, poolSeatsFor(category)],
    );
    await this.db.query(`UPDATE rides SET pool_trip_id = $2 WHERE id = $1`, [rideId, trip.id]);
    return trip.id;
  }

  /**
   * A host who leaves before a driver has been found hands the trip to the
   * longest-waiting rider on it. Returns that ride's id, or null (and closes
   * the trip) if nobody is left.
   */
  async promoteHost(tripId: string, endedRideId: string): Promise<string | null> {
    const [trip] = await this.db.query(
      `SELECT host_ride_id, driver_id FROM pool_trips WHERE id = $1`,
      [tripId],
    );
    if (!trip || trip.driver_id) return null;
    if (trip.host_ride_id && trip.host_ride_id !== endedRideId) return null;

    const [next] = await this.db.query(
      `SELECT id FROM rides
        WHERE pool_trip_id = $1 AND id <> $2 AND driver_id IS NULL
          AND status = 'requested'
        ORDER BY requested_at ASC LIMIT 1`,
      [tripId, endedRideId],
    );
    if (!next) {
      await this.closeIfDone(tripId);
      return null;
    }
    await this.db.query(`UPDATE pool_trips SET host_ride_id = $2 WHERE id = $1`, [tripId, next.id]);
    return next.id;
  }

  /** Closes the trip once no rider on it is still active. */
  async closeIfDone(tripId: string): Promise<void> {
    await this.db.query(
      `UPDATE pool_trips t
          SET status = 'closed', closed_at = now()
        WHERE t.id = $1 AND t.status = 'open'
          AND NOT EXISTS (
            SELECT 1 FROM rides r
             WHERE r.pool_trip_id = t.id AND r.status IN ${ACTIVE})`,
      [tripId],
    );
  }

  /** Riders aboard or waiting on this ride's trip, not counting the ride itself. */
  async coRiders(rideId: string): Promise<number> {
    const [row] = await this.db.query(
      `SELECT COUNT(*)::int AS n
         FROM rides me
         JOIN rides o ON o.pool_trip_id = me.pool_trip_id AND o.id <> me.id
        WHERE me.id = $1 AND o.status IN ${ACTIVE}`,
      [rideId],
    );
    return Number(row?.n ?? 0);
  }

  async activeRideIds(tripId: string): Promise<string[]> {
    const rows = await this.db.query(
      `SELECT id FROM rides WHERE pool_trip_id = $1 AND status IN ${ACTIVE}`,
      [tripId],
    );
    return rows.map((r: any) => r.id);
  }

  // =====================================================================
  // Snapshots
  // =====================================================================

  /** Open trips of a category, with the riders on each and a route to test against. */
  private async loadTrips(category: string, tripId?: string): Promise<TripSnapshot[]> {
    const trips = await this.db.query(
      `SELECT id, category, driver_id, seats_total, host_ride_id
         FROM pool_trips
        WHERE status = 'open' AND category = $1::vehicle_category
          AND ($2::uuid IS NULL OR id = $2::uuid)
        ORDER BY created_at DESC
        LIMIT 200`,
      [category, tripId ?? null],
    );
    if (trips.length === 0) return [];

    const ids = trips.map((t: any) => t.id);
    const riders = await this.db.query(
      `SELECT r.id AS ride_id, r.pool_trip_id, r.rider_id, r.status::text AS status,
              r.pickup_address, r.dropoff_address, u.full_name,
              ST_Y(r.pickup_point::geometry)  AS plat, ST_X(r.pickup_point::geometry)  AS plng,
              ST_Y(r.dropoff_point::geometry) AS dlat, ST_X(r.dropoff_point::geometry) AS dlng
         FROM rides r JOIN users u ON u.id = r.rider_id
        WHERE r.pool_trip_id = ANY($1::uuid[]) AND r.status IN ${ACTIVE}
        ORDER BY r.requested_at ASC`,
      [ids],
    );

    const byTrip = new Map<string, TripRider[]>();
    for (const r of riders) {
      const list = byTrip.get(r.pool_trip_id) ?? [];
      list.push({
        rideId: r.ride_id,
        riderId: r.rider_id,
        status: r.status,
        riderName: r.full_name,
        pickup: { lat: Number(r.plat), lng: Number(r.plng) },
        dropoff: { lat: Number(r.dlat), lng: Number(r.dlng) },
        pickupAddress: r.pickup_address,
        dropoffAddress: r.dropoff_address,
      });
      byTrip.set(r.pool_trip_id, list);
    }

    const out: TripSnapshot[] = [];
    for (const t of trips) {
      const list = byTrip.get(t.id) ?? [];
      if (list.length === 0) continue;
      const cap = Number(t.seats_total);
      out.push({
        id: t.id,
        category: t.category,
        driverId: t.driver_id,
        seatsTotal: Number(t.seats_total),
        hostRideId: t.host_ride_id,
        riders: list,
        seatsLeft: Math.max(0, cap - list.length),
        route: await this.routeFor(t.driver_id, list),
      });
    }
    return out;
  }

  /**
   * The line a joiner is tested against: vehicle -> farthest drop-off still to
   * come. A trip whose driver has gone quiet has no usable position and is
   * skipped rather than guessed at.
   */
  private async routeFor(driverId: string | null, riders: TripRider[]): Promise<RouteRef | null> {
    if (riders.length === 0) return null;

    if (!driverId) {
      const host = riders[0];
      return { from: host.pickup, to: host.dropoff, vehicleMoving: false };
    }

    const pos = await this.redis.hmget(`driver:${driverId}`, 'lat', 'lng', 'lastPingAt');
    const lat = Number(pos[0]);
    const lng = Number(pos[1]);
    const ping = Number(pos[2]);
    if (!pos[0] || !pos[1] || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    if (!Number.isFinite(ping) || Date.now() - ping > POOL.maxPingAgeMs) return null;

    const from: Pt = { lat, lng };
    let to = riders[0].dropoff;
    let far = -1;
    for (const r of riders) {
      const d = haversineM(from, r.dropoff);
      if (d > far) {
        far = d;
        to = r.dropoff;
      }
    }
    return { from, to, vehicleMoving: true };
  }

  // =====================================================================
  // Matching
  // =====================================================================

  /** Trips with a driver on the road that this rider can ride along with, best first. */
  async findLiveMatches(j: JoinerRoute, limit: number): Promise<TripMatch[]> {
    const all = await this.matchesFor(j);
    return all.filter((m) => m.trip.driverId).slice(0, limit);
  }

  /** Every trip (with or without a driver yet) the rider could join, best first. */
  async matchesFor(j: JoinerRoute): Promise<TripMatch[]> {
    if (!POOL.enabled || poolSeatsFor(j.category) === 0) return [];
    const trips = await this.loadTrips(j.category);
    const out: TripMatch[] = [];
    for (const trip of trips) {
      if (!trip.route || trip.seatsLeft < 1) continue;
      if (trip.riders.some((r) => r.riderId === j.riderId)) continue;
      const verdict = evaluateMatch(trip.route, { pickup: j.pickup, dropoff: j.dropoff });
      if (verdict.ok) out.push({ trip, verdict });
    }
    // Least extra driving first, then the nearest pickup.
    out.sort((a, b) => a.verdict.detourM - b.verdict.detourM || a.verdict.toPickupM - b.verdict.toPickupM);
    return out;
  }

  /** One named trip, tested for this rider. Null if it is not joinable at all. */
  async checkJoin(tripId: string, j: JoinerRoute): Promise<TripMatch | null> {
    const [trip] = await this.loadTrips(j.category, tripId);
    if (!trip || !trip.route || trip.seatsLeft < 1) return null;
    if (trip.riders.some((r) => r.riderId === j.riderId)) return null;
    const verdict = evaluateMatch(trip.route, { pickup: j.pickup, dropoff: j.dropoff });
    return verdict.ok ? { trip, verdict } : null;
  }

  // =====================================================================
  // Reporting
  // =====================================================================

  async stats(timezone: string) {
    const [row] = await this.db.query(
      `SELECT
         COUNT(DISTINCT pool_trip_id)                                   AS trips,
         COUNT(*)                                                       AS pool_rides,
         COUNT(*) FILTER (WHERE status = 'completed' AND pool_shared_with > 0) AS shared_rides,
         COALESCE(SUM(pool_discount_cents) FILTER (WHERE status = 'completed'), 0) AS discount_cents
       FROM rides
      WHERE pool_mode IS NOT NULL
        AND (requested_at AT TIME ZONE '${timezone}')::date
            = (now() AT TIME ZONE '${timezone}')::date`,
    );
    return {
      trips: Number(row.trips),
      poolRides: Number(row.pool_rides),
      sharedRides: Number(row.shared_rides),
      discountCents: Number(row.discount_cents),
    };
  }
}
