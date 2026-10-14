/**
 * In-ride messaging between the rider and their driver.
 *
 * Only the two people on a trip can read or write its thread, and only while
 * the trip is live (or just finished, so "I left my bag" still reaches the
 * driver). Numbers are shared the same way: the counterpart's phone is
 * returned by contact() only for a live trip, never as a directory lookup.
 */

import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { NotificationsService } from '../notifications/notifications.service';

const LIVE_STATUSES = ['accepted', 'arrived', 'in_progress'];
/** After completion the thread stays open this long. */
const GRACE_MINUTES = 30;

interface Party {
  riderId: string;
  driverUserId: string | null;
  status: string;
  closedRecently: boolean;
}

@Injectable()
export class MessagesService {
  constructor(
    private readonly db: DataSource,
    private readonly push: NotificationsService,
  ) {}

  private async party(rideId: string): Promise<Party> {
    const [r] = await this.db.query(
      `SELECT r.rider_id, d.user_id AS driver_user_id, r.status::text AS status,
              (r.completed_at IS NOT NULL
                 AND r.completed_at > now() - ($2 || ' minutes')::interval) AS closed_recently
         FROM rides r LEFT JOIN drivers d ON d.id = r.driver_id
        WHERE r.id = $1`,
      [rideId, String(GRACE_MINUTES)],
    );
    if (!r) throw new NotFoundException('ride not found');
    return {
      riderId: r.rider_id,
      driverUserId: r.driver_user_id,
      status: r.status,
      closedRecently: !!r.closed_recently,
    };
  }

  private assertParticipant(p: Party, userId: string) {
    if (userId !== p.riderId && userId !== p.driverUserId) {
      throw new ForbiddenException('not part of this trip');
    }
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

  /** Stores a message and returns it with the recipient so callers can fan out. */
  async send(rideId: string, userId: string, body: string) {
    const p = await this.party(rideId);
    this.assertParticipant(p, userId);
    if (!LIVE_STATUSES.includes(p.status) && !p.closedRecently) {
      throw new ForbiddenException('messaging is closed for this trip');
    }

    const text = body.trim().slice(0, 500);
    const [m] = await this.db.query(
      `INSERT INTO ride_messages (ride_id, sender_id, body)
       VALUES ($1, $2, $3) RETURNING id, created_at`,
      [rideId, userId, text],
    );

    const recipient = userId === p.riderId ? p.driverUserId : p.riderId;
    const recipientApp: 'rider' | 'driver' = userId === p.riderId ? 'driver' : 'rider';
    if (recipient) {
      void this.push.sendToUser(
        recipient,
        {
          title: 'push.message.t',
          bodyText: text.slice(0, 120),
          data: { type: 'ride_message', rideId },
        },
        recipientApp,
      );
    }
    return { id: m.id, at: m.created_at, body: text, recipientId: recipient };
  }

  /** The other party's name and number, for a normal phone call. Live trips only. */
  async contact(rideId: string, userId: string) {
    const p = await this.party(rideId);
    this.assertParticipant(p, userId);
    if (!LIVE_STATUSES.includes(p.status)) {
      throw new ForbiddenException('contact details are only available during a trip');
    }
    const otherId = userId === p.riderId ? p.driverUserId : p.riderId;
    if (!otherId) throw new NotFoundException('no driver assigned yet');
    const [u] = await this.db.query(`SELECT full_name, phone FROM users WHERE id = $1`, [otherId]);
    return { name: u?.full_name ?? null, phone: u?.phone ?? null };
  }
}
