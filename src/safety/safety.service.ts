/**
 * Emergency SOS.
 *
 * Principles, in order of importance:
 *
 *   An alert is never lost. No validation failure, missing GPS fix, absent
 *   trip or database hiccup may prevent the alarm being raised. Every optional
 *   detail is genuinely optional, and the write is the last thing that can
 *   fail rather than the first.
 *
 *   Speed over completeness. The response returns as soon as the alert is
 *   recorded; notifying the emergency contact and the ops team happens after,
 *   so a slow SMS gateway cannot delay the confirmation the person is staring
 *   at.
 *
 *   The emergency number is offered, not relied upon: it may not connect
 *   dependably everywhere, so the alert also reaches
 *   ${country.brand} operations and the person's own contact.
 */

import { Injectable, Inject, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import Redis from 'ioredis';

import { REDIS } from '../common/redis.module';
import { country } from '../common/country';
import { ShareService } from '../share/share.service';

export interface SosContext {
  name: string | null;
  phone: string | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  ride: {
    reference: string | null;
    status: string | null;
    pickup: string | null;
    dropoff: string | null;
    riderName: string | null;
    riderPhone: string | null;
    driverName: string | null;
    driverPhone: string | null;
    vehicle: string | null;
  } | null;
}

export interface SosInput {
  userId: string;
  role: 'rider' | 'driver';
  rideId?: string | null;
  lat?: number | null;
  lng?: number | null;
  accuracyM?: number | null;
  note?: string | null;
}

/**
 * Emergency numbers for the configured country. Surfaced together because
 * coverage varies by region and carrier. Each country's numbers must be confirmed
 * in writing by the client before launch (country.emergencyUnverified).
 */
export const EMERGENCY_NUMBERS = {
  primary: country.emergency.primary,
  ambulance: country.emergency.ambulance,
  fire: country.emergency.fire,
  label: country.emergency.label,
};

@Injectable()
export class SafetyService {
  private readonly logger = new Logger(SafetyService.name);

  constructor(
    private readonly db: DataSource,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly share: ShareService,
  ) {}

  /**
   * Raises an alert. Returns as soon as it is on record.
   *
   * `notify` is injected by the controller so this stays free of socket
   * concerns and can be tested without a gateway.
   */
  async raise(
    input: SosInput,
    notify?: (payload: Record<string, unknown>) => void,
  ) {
    const hasPosition =
      typeof input.lat === 'number' && typeof input.lng === 'number' &&
      Number.isFinite(input.lat) && Number.isFinite(input.lng);

    let alertId: string | null = null;

    // SOS pressed from the home screen carries no ride id. If the person is
    // on a trip right now, attach it anyway: the trip is the most useful
    // thing the emergency contact and ops can be told.
    if (!input.rideId) {
      input.rideId = await this.activeRideId(input.userId);
    }

    try {
      const [row] = await this.db.query(
        `INSERT INTO sos_alerts
           (user_id, ride_id, raised_by, position, accuracy_m, note)
         VALUES ($1, $2, $3::sos_source,
                 ${hasPosition
                   ? 'ST_SetSRID(ST_MakePoint($4, $5), 4326)::geography'
                   : 'NULL'},
                 $6, $7)
         RETURNING id, created_at`,
        hasPosition
          ? [input.userId, input.rideId ?? null, input.role, input.lng, input.lat,
             input.accuracyM ?? null, input.note ?? null]
          : [input.userId, input.rideId ?? null, input.role, null, null,
             input.accuracyM ?? null, input.note ?? null],
      );
      alertId = row.id;
    } catch (err) {
      // The alarm still goes out. A database problem must not silence an
      // emergency — ops get the alert over the socket regardless, and the
      // failure is logged loudly for follow-up.
      this.logger.error(
        `SOS WRITE FAILED for user ${input.userId}: ${(err as Error).message}`,
      );
    }

    this.logger.warn(
      `SOS raised by ${input.role} ${input.userId}` +
        (input.rideId ? ` on ride ${input.rideId}` : '') +
        (hasPosition ? ` at ${input.lat},${input.lng}` : ' with no GPS fix'),
    );

    const context = await this.context(input.userId, input.rideId ?? null);

    // Push to operations immediately; everything else is best effort.
    const payload = {
      alertId,
      userId: input.userId,
      role: input.role,
      rideId: input.rideId ?? null,
      lat: input.lat ?? null,
      lng: input.lng ?? null,
      raisedAt: new Date().toISOString(),
      ...context,
    };
    try { notify?.(payload); } catch { /* never block on delivery */ }

    // A short-lived flag so the admin panel can highlight the person even if
    // it missed the socket event.
    if (alertId) {
      await this.redis
        .set(`sos:open:${alertId}`, JSON.stringify(payload), 'EX', 86_400)
        .catch(() => undefined);
    }

    // A live tracking link for the trip, so the contact can follow the
    // vehicle in real time and not only see where the alert was raised.
    let trackUrl: string | null = null;
    if (input.rideId) {
      try {
        trackUrl = (await this.share.create(input.rideId, input.userId, 'sos')).url;
      } catch (err) {
        this.logger.error(`SOS share link failed: ${(err as Error).message}`);
      }
    }

    void this.notifyEmergencyContact(alertId, input.role, context, input.lat, input.lng, trackUrl);

    return {
      raised: true,
      alertId,
      emergency: EMERGENCY_NUMBERS,
      contactNotified: Boolean(context.emergencyContactPhone),
      // Told plainly, because someone in trouble should not be guessing.
      message: hasPosition
        ? 'Alert sent with your location.'
        : 'Alert sent. Your location was unavailable, so describe where you are when we call.',
    };
  }

  /**
   * The trip the person is on right now, as rider or as driver, if any.
   * Never throws: a failed lookup only means the alert goes without trip
   * details.
   */
  private async activeRideId(userId: string): Promise<string | null> {
    try {
      const [r] = await this.db.query(
        `SELECT r.id
           FROM rides r
           LEFT JOIN drivers d ON d.id = r.driver_id
          WHERE (r.rider_id = $1 OR d.user_id = $1)
            AND r.status IN ('requested', 'searching', 'accepted', 'arrived', 'in_progress')
          ORDER BY r.requested_at DESC
          LIMIT 1`,
        [userId],
      );
      return r?.id ?? null;
    } catch (err) {
      this.logger.error(`SOS active-ride lookup failed: ${(err as Error).message}`);
      return null;
    }
  }

  /** Who and what, so ops do not have to look anything up. */
  private async context(userId: string, rideId: string | null): Promise<SosContext> {
    try {
      const [user] = await this.db.query(
        `SELECT full_name, phone, emergency_contact_name, emergency_contact_phone
           FROM users WHERE id = $1`,
        [userId],
      );

      let ride: any = null;
      if (rideId) {
        const [r] = await this.db.query(
          `SELECT r.reference, r.status, r.pickup_address, r.dropoff_address,
                  ru.full_name AS rider_name, ru.phone AS rider_phone,
                  du.full_name AS driver_name, du.phone AS driver_phone,
                  v.plate_number, v.make, v.model, v.colour
             FROM rides r
             JOIN users ru ON ru.id = r.rider_id
             LEFT JOIN drivers d ON d.id = r.driver_id
             LEFT JOIN users du ON du.id = d.user_id
             LEFT JOIN vehicles v ON v.id = r.vehicle_id
            WHERE r.id = $1`,
          [rideId],
        );
        ride = r ?? null;
      }

      return {
        name: user?.full_name ?? null,
        phone: user?.phone ?? null,
        emergencyContactName: user?.emergency_contact_name ?? null,
        emergencyContactPhone: user?.emergency_contact_phone ?? null,
        ride: ride && {
          reference: ride.reference,
          status: ride.status,
          pickup: ride.pickup_address,
          dropoff: ride.dropoff_address,
          riderName: ride.rider_name,
          riderPhone: ride.rider_phone,
          driverName: ride.driver_name,
          driverPhone: ride.driver_phone,
          vehicle: ride.plate_number
            ? `${ride.colour ?? ''} ${ride.make ?? ''} ${ride.model ?? ''} · ${ride.plate_number}`.trim()
            : null,
        },
      };
    } catch (err) {
      this.logger.error(`SOS context lookup failed: ${(err as Error).message}`);
      return { name: null, phone: null, emergencyContactName: null,
               emergencyContactPhone: null, ride: null };
    }
  }

  /**
   * The facts an emergency contact needs, in one place, so WhatsApp, SMS,
   * the wa.me link and the admin panel all say the same thing.
   */
  private emergencyFacts(
    name: string | null,
    role: 'rider' | 'driver' | null,
    phone: string | null,
    lat?: number | null,
    lng?: number | null,
    ride?: SosContext['ride'] | null,
  ) {
    const who = (name ?? '').trim() || 'Your contact';
    const location =
      lat != null && lng != null
        ? `https://maps.google.com/?q=${lat},${lng}`
        : 'Location unavailable';
    const time = new Date().toLocaleString('en-GB', {
      timeZone: country.timezone,
      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    });

    // Ride details as short labelled parts. The template version joins them
    // on one line, because WhatsApp template parameters may not contain
    // line breaks.
    const rideParts: string[] = [];
    if (ride) {
      if (ride.reference) rideParts.push(`Trip ${ride.reference} (${String(ride.status ?? '').replace('_', ' ')})`);
      if (ride.pickup) rideParts.push(`From: ${ride.pickup}`);
      if (ride.dropoff) rideParts.push(`To: ${ride.dropoff}`);
      if (role !== 'driver' && ride.driverName) {
        rideParts.push(`Driver: ${ride.driverName}${ride.driverPhone ? ` ${ride.driverPhone}` : ''}`);
      }
      if (ride.vehicle) rideParts.push(`Vehicle: ${ride.vehicle}`);
      if (role === 'driver' && ride.riderName) {
        rideParts.push(`Passenger: ${ride.riderName}${ride.riderPhone ? ` ${ride.riderPhone}` : ''}`);
      }
    }

    return {
      who,
      phone,
      location,
      time,
      rideParts,
      emergencyLine: `${EMERGENCY_NUMBERS.label}: ${EMERGENCY_NUMBERS.primary}` +
        (EMERGENCY_NUMBERS.ambulance ? `, ambulance ${EMERGENCY_NUMBERS.ambulance}` : ''),
    };
  }

  /**
   * The full message, for SMS, plain WhatsApp text and wa.me links.
   *
   * A Google Maps link rather than raw coordinates: the contact is a family
   * member on a phone, not an operator with a mapping tool.
   */
  private emergencyText(
    name: string | null,
    lat?: number | null,
    lng?: number | null,
    ride?: SosContext['ride'] | null,
    role: 'rider' | 'driver' | null = null,
    phone: string | null = null,
    trackUrl: string | null = null,
  ): string {
    const f = this.emergencyFacts(name, role, phone, lat, lng, ride);
    return (
      `${country.brand.toUpperCase()} EMERGENCY\n\n` +
      `${f.who}${f.phone ? ` (${f.phone})` : ''} raised an emergency alert at ${f.time}.\n\n` +
      `Location: ${f.location}\n` +
      (trackUrl ? `Follow the trip live: ${trackUrl}\n` : '') +
      (f.rideParts.length ? `\n${f.rideParts.join('\n')}\n` : '') +
      `\nCall them now. If you cannot reach them, call ${f.emergencyLine}.`
    );
  }

  /**
   * Sends the alert to the contact over WhatsApp (Meta Cloud API format).
   *
   * WhatsApp only delivers a business-initiated message to someone who has
   * not written to the business in the last 24 hours if it is an approved
   * template. An emergency contact has almost never written to us, so the
   * template is the path that actually arrives. Free text is tried only
   * when no template is configured, or the template send fails, and is
   * delivered only if that contact happens to be inside the 24-hour window.
   *
   * Template (category UTILITY), registered in WhatsApp Manager under the
   * name in WHATSAPP_TEMPLATE_NAME, body with four parameters:
   *
   *   EMERGENCY ALERT: {{1}} has pressed the emergency button in the
   *   Kwema Ride app. Location: {{2}} Trip: {{3}} Please call them now.
   *   If you cannot reach them, call {{4}}.
   */
  private async sendWhatsApp(
    to: string,
    text: string,
    params: [string, string, string, string],
  ): Promise<boolean> {
    const url = process.env.WHATSAPP_API_URL;
    const token = process.env.WHATSAPP_TOKEN;
    if (!url || !token) return false;

    const recipient = to.replace('+', '');
    const post = async (body: Record<string, unknown>) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ messaging_product: 'whatsapp', to: recipient, ...body }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        this.logger.error(`whatsapp send failed: ${res.status} ${detail.slice(0, 300)}`);
      }
      return res.ok;
    };

    const template = process.env.WHATSAPP_TEMPLATE_NAME;
    try {
      if (template) {
        // Template parameters: no line breaks, tabs or runs of spaces, and
        // never empty.
        const clean = (v: string) =>
          (v || '-').replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, 900);
        const sent = await post({
          type: 'template',
          template: {
            name: template,
            language: { code: process.env.WHATSAPP_TEMPLATE_LANG || 'en' },
            components: [{
              type: 'body',
              parameters: params.map((p) => ({ type: 'text', text: clean(p) })),
            }],
          },
        });
        if (sent) return true;
      }
      return await post({ type: 'text', text: { preview_url: true, body: text } });
    } catch (err) {
      this.logger.error(`whatsapp send error: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * A wa.me deep link the apps and the admin panel can open directly.
   *
   * This works with no Business API credentials at all — it opens WhatsApp
   * with the message pre-filled. It requires a human to press send, so it
   * complements automatic delivery rather than replacing it, and it is what
   * lets an operator reach a contact immediately from the SOS queue.
   */
  whatsappLink(to: string, text: string): string {
    return `https://wa.me/${to.replace('+', '')}?text=${encodeURIComponent(text)}`;
  }

  /**
   * Messages the person's own emergency contact, automatically, the moment
   * the alert is on record.
   *
   * Fire-and-forget: a slow or failing gateway must not delay the
   * confirmation shown to someone in trouble.
   */
  private async notifyEmergencyContact(
    alertId: string | null,
    role: 'rider' | 'driver',
    context: SosContext,
    lat?: number | null,
    lng?: number | null,
    trackUrl: string | null = null,
  ): Promise<void> {
    try {
      const to = context.emergencyContactPhone;
      if (!to) return;

      const text = this.emergencyText(context.name, lat, lng, context.ride, role, context.phone, trackUrl);
      const f = this.emergencyFacts(context.name, role, context.phone, lat, lng, context.ride);

      // Both channels, deliberately. WhatsApp carries the map link properly
      // and is what people actually read here; SMS reaches a handset with no
      // data or no WhatsApp installed. In an emergency the duplicate cost is
      // not worth optimising away.
      const viaWhatsApp = await this.sendWhatsApp(to, text, [
        `${f.who}${f.phone ? ` (${f.phone})` : ''} at ${f.time}`,
        trackUrl ? `${f.location} Live tracking: ${trackUrl}` : f.location,
        f.rideParts.length ? f.rideParts.join('; ') : 'Not on a trip',
        f.emergencyLine,
      ]);
      if (viaWhatsApp) this.logger.log(`emergency contact reached on WhatsApp`);

      if (!process.env.SMS_API_URL) {
        this.logger.warn(`[dev] would message ${to}: ${text}`);
      } else {
        await fetch(process.env.SMS_API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${process.env.SMS_API_KEY}`,
          },
          body: JSON.stringify({
            source_addr: process.env.SMS_SENDER_ID ?? country.brand.replace(/[^A-Za-z0-9]/g, '').slice(0, 11).toUpperCase(),
            recipients: [{ recipient_id: 1, dest_addr: to.replace('+', '') }],
            message: text,
          }),
        });
      }

      if (alertId) {
        await this.db.query(
          `UPDATE sos_alerts SET contact_notified_at = now() WHERE id = $1`,
          [alertId],
        );
      }
    } catch (err) {
      this.logger.error(`emergency contact notify failed: ${(err as Error).message}`);
    }
  }

  /** The person's own emergency contact, set from the account screen. */
  async setEmergencyContact(userId: string, name: string, phone: string) {
    if (!/^\+[0-9]{9,15}$/.test(phone)) {
      throw new Error(`phone must be in international format, e.g. +${country.dialCode}${'X'.repeat(country.phoneDigits)}`);
    }
    await this.db.query(
      `UPDATE users
          SET emergency_contact_name = $2, emergency_contact_phone = $3
        WHERE id = $1`,
      [userId, name.trim().slice(0, 120), phone],
    );
    return { saved: true };
  }

  async getEmergencyContact(userId: string) {
    const [row] = await this.db.query(
      `SELECT emergency_contact_name AS name, emergency_contact_phone AS phone,
              full_name
         FROM users WHERE id = $1`,
      [userId],
    );
    return {
      name: row?.name ?? null,
      phone: row?.phone ?? null,
      emergency: EMERGENCY_NUMBERS,
      // Lets the app offer "message my contact on WhatsApp" without needing
      // Business API credentials configured.
      whatsappTemplate: row?.phone
        ? this.whatsappLink(row.phone, this.emergencyText(row.full_name))
        : null,
    };
  }

  // -------------------------------------------------------------------
  // Operations
  // -------------------------------------------------------------------

  async open(limit = 50) {
    const rows = await this.db.query(
      `SELECT s.id, s.raised_by, s.status, s.note, s.created_at,
              s.acknowledged_at, s.emergency_called, s.contact_notified_at,
              ST_Y(s.position::geometry) AS lat,
              ST_X(s.position::geometry) AS lng,
              u.full_name, u.phone,
              u.emergency_contact_name, u.emergency_contact_phone,
              r.reference AS ride_reference, r.status AS ride_status,
              r.pickup_address, r.dropoff_address
         FROM sos_alerts s
         JOIN users u ON u.id = s.user_id
         LEFT JOIN rides r ON r.id = s.ride_id
        WHERE s.status IN ('open', 'acknowledged')
        ORDER BY s.created_at DESC
        LIMIT $1`,
      [limit],
    );

    // Precomputed so an operator can reach the contact in one click rather
    // than composing a message while someone waits.
    return rows.map((r: any) => ({
      ...r,
      contactWhatsapp: r.emergency_contact_phone
        ? this.whatsappLink(
            r.emergency_contact_phone,
            this.emergencyText(
              r.full_name, r.lat, r.lng,
              r.ride_reference
                ? {
                    reference: r.ride_reference, status: r.ride_status,
                    pickup: r.pickup_address, dropoff: r.dropoff_address,
                    riderName: null, riderPhone: null,
                    driverName: null, driverPhone: null, vehicle: null,
                  }
                : null,
              r.raised_by, r.phone,
            ),
          )
        : null,
    }));
  }

  async history(limit = 100) {
    return this.db.query(
      `SELECT s.id, s.raised_by, s.status, s.created_at, s.resolved_at,
              s.resolution, u.full_name, u.phone, r.reference AS ride_reference
         FROM sos_alerts s
         JOIN users u ON u.id = s.user_id
         LEFT JOIN rides r ON r.id = s.ride_id
        ORDER BY s.created_at DESC
        LIMIT $1`,
      [limit],
    );
  }

  async acknowledge(alertId: string, adminId: string) {
    const [row] = await this.db.query(
      `UPDATE sos_alerts
          SET status = 'acknowledged', acknowledged_by = $2, acknowledged_at = now()
        WHERE id = $1 AND status = 'open'
        RETURNING id`,
      [alertId, adminId],
    );
    return { acknowledged: Boolean(row) };
  }

  async resolve(alertId: string, adminId: string, resolution: string, falseAlarm = false) {
    await this.db.query(
      `UPDATE sos_alerts
          SET status = $3::sos_status, resolved_at = now(),
              resolution = $2, acknowledged_by = COALESCE(acknowledged_by, $4)
        WHERE id = $1`,
      [alertId, resolution, falseAlarm ? 'false_alarm' : 'resolved', adminId],
    );
    await this.redis.del(`sos:open:${alertId}`).catch(() => undefined);
    return { resolved: true };
  }
}
