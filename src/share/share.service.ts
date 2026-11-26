/**
 * Live trip sharing.
 *
 * A rider or driver on a trip creates a link and sends it by WhatsApp or SMS.
 * Whoever opens it sees the trip move on a map in real time, with the
 * driver, vehicle and plate, without installing anything or signing in.
 *
 * Privacy rules, because the link travels outside the app:
 *  - The token is the only key: 32 random bytes, unguessable.
 *  - Only first names are shown, never phone numbers.
 *  - Live position stops the moment the trip completes or is cancelled,
 *    and the link stops working an hour later (or after 24 h at most).
 */

import { Injectable, Inject, Logger, ForbiddenException, NotFoundException, BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import Redis from 'ioredis';
import { randomBytes } from 'node:crypto';

import { REDIS } from '../common/redis.module';
import { country } from '../common/country';

const ACTIVE = ['requested', 'searching', 'accepted', 'arrived', 'in_progress'];
/** Statuses in which the driver's live position is shown. */
const LIVE = ['accepted', 'arrived', 'in_progress'];
const MAX_LINK_HOURS = 24;
const AFTER_END_MINUTES = 60;

export interface ShareLink {
  url: string;
  token: string;
  text: string;
  whatsappUrl: string;
  smsUrl: string;
  expiresAt: string;
}

@Injectable()
export class ShareService {
  private readonly logger = new Logger(ShareService.name);

  constructor(
    private readonly db: DataSource,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  private baseUrl(): string {
    return (process.env.PUBLIC_BASE_URL ?? '').replace(/\/+$/, '');
  }

  private firstName(name: string | null | undefined): string | null {
    const n = String(name ?? '').trim().split(/\s+/)[0];
    return n || null;
  }

  /**
   * Creates a share link for a trip the user is on, as rider or driver.
   * Reuses a still-valid link so sharing twice sends the same URL.
   */
  async create(rideId: string, userId: string, reason: 'manual' | 'sos' = 'manual'): Promise<ShareLink> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rideId)) {
      throw new NotFoundException('ride_not_found');
    }
    const [ride] = await this.db.query(
      `SELECT r.id, r.status, r.rider_id, du.id AS driver_user_id,
              ru.full_name AS rider_name, du.full_name AS driver_name,
              v.plate_number
         FROM rides r
         JOIN users ru ON ru.id = r.rider_id
         LEFT JOIN drivers d ON d.id = r.driver_id
         LEFT JOIN users du ON du.id = d.user_id
         LEFT JOIN vehicles v ON v.id = r.vehicle_id
        WHERE r.id = $1`,
      [rideId],
    );
    if (!ride) throw new NotFoundException('ride_not_found');
    if (ride.rider_id !== userId && ride.driver_user_id !== userId) {
      throw new ForbiddenException('not_your_ride');
    }
    if (!ACTIVE.includes(ride.status)) {
      throw new BadRequestException('trip_not_active');
    }

    const [existing] = await this.db.query(
      `SELECT token, expires_at FROM ride_shares
        WHERE ride_id = $1 AND created_by = $2 AND expires_at > now() + interval '1 hour'
        ORDER BY created_at DESC LIMIT 1`,
      [rideId, userId],
    );

    let token: string = existing?.token;
    let expiresAt: Date = existing ? new Date(existing.expires_at) : new Date();
    if (!token) {
      token = randomBytes(32).toString('base64url');
      expiresAt = new Date(Date.now() + MAX_LINK_HOURS * 3_600_000);
      await this.db.query(
        `INSERT INTO ride_shares (ride_id, token, created_by, reason, expires_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [rideId, token, userId, reason, expiresAt],
      );
    }

    const url = `${this.baseUrl()}/track?t=${token}`;
    const who = this.firstName(ride.rider_id === userId ? ride.rider_name : ride.driver_name) ?? 'I';
    const text =
      `${who === 'I' ? "I'm" : `${who} is`} on a ${country.brand} trip` +
      (ride.plate_number ? ` (vehicle ${ride.plate_number})` : '') +
      `. Follow it live: ${url}`;

    return {
      url,
      token,
      text,
      whatsappUrl: `https://wa.me/?text=${encodeURIComponent(text)}`,
      smsUrl: `sms:?body=${encodeURIComponent(text)}`,
      expiresAt: expiresAt.toISOString(),
    };
  }

  /** What the public tracking page shows. */
  async view(token: string) {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) throw new NotFoundException('link_not_found');

    const [row] = await this.db.query(
      `SELECT s.expires_at, r.id AS ride_id, r.reference, r.status, r.service_type,
              r.pickup_address, r.dropoff_address,
              ST_Y(r.pickup_point::geometry) AS plat, ST_X(r.pickup_point::geometry) AS plng,
              ST_Y(r.dropoff_point::geometry) AS dlat, ST_X(r.dropoff_point::geometry) AS dlng,
              r.started_at, r.completed_at, r.cancelled_at,
              COALESCE(r.passenger_name, ru.full_name) AS rider_name,
              du.full_name AS driver_name, d.id AS driver_id,
              v.plate_number, v.make, v.model, v.colour, v.category,
              ST_Y(d.last_location::geometry) AS dblat, ST_X(d.last_location::geometry) AS dblng,
              d.last_location_at
         FROM ride_shares s
         JOIN rides r ON r.id = s.ride_id
         JOIN users ru ON ru.id = r.rider_id
         LEFT JOIN drivers d ON d.id = r.driver_id
         LEFT JOIN users du ON du.id = d.user_id
         LEFT JOIN vehicles v ON v.id = r.vehicle_id
        WHERE s.token = $1`,
      [token],
    );
    if (!row) throw new NotFoundException('link_not_found');

    const endedAt = row.completed_at ?? row.cancelled_at;
    const expired =
      new Date(row.expires_at).getTime() < Date.now() ||
      (endedAt && new Date(endedAt).getTime() + AFTER_END_MINUTES * 60_000 < Date.now());
    if (expired) throw new NotFoundException('link_expired');

    // Freshest position: the live ping in Redis, else the last stored one.
    let driver: { lat: number; lng: number; heading: number; at: string } | null = null;
    if (row.driver_id && LIVE.includes(row.status)) {
      const live = await this.redis.hgetall(`driver:${row.driver_id}`).catch(() => ({} as Record<string, string>));
      if (live?.lat && live?.lng) {
        driver = {
          lat: Number(live.lat),
          lng: Number(live.lng),
          heading: Number(live.heading ?? 0),
          at: new Date(Number(live.lastPingAt ?? Date.now())).toISOString(),
        };
      } else if (row.dblat != null) {
        driver = {
          lat: Number(row.dblat),
          lng: Number(row.dblng),
          heading: 0,
          at: row.last_location_at ? new Date(row.last_location_at).toISOString() : new Date().toISOString(),
        };
      }
    }

    return {
      brand: country.brand,
      reference: row.reference,
      status: row.status,
      service: row.service_type,
      riderFirstName: this.firstName(row.rider_name),
      driverFirstName: this.firstName(row.driver_name),
      vehicle: row.plate_number
        ? {
            plate: row.plate_number,
            description: [row.colour, row.make, row.model].filter(Boolean).join(' ') || null,
            category: row.category,
          }
        : null,
      pickup: { address: row.pickup_address, lat: Number(row.plat), lng: Number(row.plng) },
      dropoff: { address: row.dropoff_address, lat: Number(row.dlat), lng: Number(row.dlng) },
      driver,
      startedAt: row.started_at,
      endedAt,
      emergency: country.emergency,
      updatedAt: new Date().toISOString(),
    };
  }
}
