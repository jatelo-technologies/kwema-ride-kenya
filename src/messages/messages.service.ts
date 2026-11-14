/**
 * In-ride communication between a rider and their driver: text chat and the
 * rules for who may call whom.
 *
 * The only channel between the two people is inside the app, and only while
 * their trip is live. Nobody's phone number is ever returned by this module.
 * Once the trip ends, the thread is closed for new messages (the history stays
 * readable to the two participants for disputes and lost-property follow-up).
 */

import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { NotificationsService } from '../notifications/notifications.service';

export const LIVE_STATUSES = ['accepted', 'arrived', 'in_progress'];

interface Party {
  riderId: string;
  driverUserId: string | null;
  status: string;
}

@Injectable()
export class MessagesService {
  constructor(
    private readonly db: DataSource,
    private readonly push: NotificationsService,
  ) {}

  async party(rideId: string): Promise<Party> {
    const [r] = await this.db.query(
      `SELECT r.rider_id, d.user_id AS driver_user_id, r.status::text AS status
         FROM rides r LEFT JOIN drivers d ON d.id = r.driver_id
        WHERE r.id = $1`,
      [rideId],
    );
    if (!r) throw new NotFoundException('ride not found');
    return { riderId: r.rider_id, driverUserId: r.driver_user_id, status: r.status };
  }

  private assertParticipant(p: Party, userId: string) {
    if (userId !== p.riderId && userId !== p.driverUserId) {
      throw new ForbiddenException('not part of this trip');
    }
  }

  /** The other person on a live trip, or null when `userId` may not signal. */
  async liveCounterpart(rideId: string, userId: string): Promise<string | null> {
    let p: Party;
    try {
      p = await this.party(rideId);
    } catch {
      return null;
    }
    if (userId !== p.riderId && userId !== p.driverUserId) return null;
    if (!LIVE_STATUSES.includes(p.status)) return null;
    return userId === p.riderId ? p.driverUserId : p.riderId;
  }

  async list(rideId: string, userId: string, after?: string) {
    const p = await this.party(rideId);
    this.assertParticipant(p, userId);
    const rows = await this.db.query(
      `SELECT id, sender_id, body, created_at
         FROM ride_messages
        WHERE ride_id = $1 AND ($2::timestamptz IS NULL OR created_at > $2::timestamptz)
        ORDER BY created_at ASC
        LIMIT 200`,
      [rideId, after ?? null],
    );
    return rows.map((m: any) => ({
      id: m.id,
      mine: m.sender_id === userId,
      body: m.body,
      at: m.created_at,
    }));
  }

  async send(rideId: string, userId: string, body: string) {
    const p = await this.party(rideId);
    this.assertParticipant(p, userId);
    if (!LIVE_STATUSES.includes(p.status)) {
      throw new ForbiddenException('messaging is only open during a trip');
    }
    const text = body.trim().slice(0, 500);
    if (!text) throw new ForbiddenException('empty message');
    const [m] = await this.db.query(
      `INSERT INTO ride_messages (ride_id, sender_id, body)
       VALUES ($1, $2, $3) RETURNING id, created_at`,
      [rideId, userId, text],
    );
    const recipientId = userId === p.riderId ? p.driverUserId : p.riderId;
    // A push as well, for when the other person's app is in the background.
    if (recipientId) {
      void this.push.sendToUser(
        recipientId,
        { title: 'push.message.t', bodyText: text.slice(0, 120), data: { type: 'ride_message', rideId } },
        userId === p.riderId ? 'driver' : 'rider',
      );
    }
    return { id: m.id, at: m.created_at, body: text, recipientId };
  }

  /** Who the rider is talking to / who the driver is talking to — name only. */
  async counterpart(rideId: string, userId: string) {
    const p = await this.party(rideId);
    this.assertParticipant(p, userId);
    const otherId = userId === p.riderId ? p.driverUserId : p.riderId;
    if (!otherId) throw new NotFoundException('no driver assigned yet');
    const [u] = await this.db.query(`SELECT full_name FROM users WHERE id = $1`, [otherId]);
    return { name: u?.full_name ?? null, live: LIVE_STATUSES.includes(p.status) };
  }

  /** ICE servers for in-app audio calls. TURN is optional but strongly advised. */
  iceServers() {
    const servers: Array<{ urls: string[]; username?: string; credential?: string }> = [
      { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    ];
    const turn = (process.env.TURN_URLS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (turn.length) {
      servers.push({
        urls: turn,
        username: process.env.TURN_USERNAME,
        credential: process.env.TURN_CREDENTIAL,
      });
    }
    return servers;
  }
}
