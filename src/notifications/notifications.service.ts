/**
 * Push notifications through Firebase Cloud Messaging (HTTP v1).
 *
 * Works for Android directly and for iPhone through FCM's APNs bridge, so one
 * sender serves both apps. Needs a Firebase project owned by the client:
 * set FCM_SERVICE_ACCOUNT_JSON to the service-account key (raw JSON or
 * base64). Without it every call is a logged no-op and the product still
 * works over sockets — push is an enhancement for backgrounded apps.
 *
 * No SDK: the OAuth assertion is signed with node:crypto, which avoids a
 * heavy dependency for two HTTP calls.
 */

import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { DataSource } from 'typeorm';
import { firstValueFrom, timeout } from 'rxjs';
import * as crypto from 'node:crypto';
import { msg, MsgKey } from '../common/messages';

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export interface PushMessage {
  /** Catalogue keys (src/common/messages.ts), resolved per recipient language. */
  title: MsgKey;
  body?: MsgKey;
  /** Verbatim text (e.g. a chat message) used when there is no catalogue key. */
  bodyText?: string;
  params?: Record<string, string>;
  data?: Record<string, string>;
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  private readonly account: ServiceAccount | null = this.loadAccount();
  private cached: { token: string; expiresAt: number } | null = null;
  private warned = false;

  constructor(
    private readonly db: DataSource,
    private readonly http: HttpService,
  ) {}

  private loadAccount(): ServiceAccount | null {
    const raw = process.env.FCM_SERVICE_ACCOUNT_JSON;
    if (!raw) return null;
    try {
      const text = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
      const parsed = JSON.parse(text);
      if (!parsed.project_id || !parsed.client_email || !parsed.private_key) return null;
      return parsed;
    } catch {
      this.logger.error('FCM_SERVICE_ACCOUNT_JSON is set but could not be parsed');
      return null;
    }
  }

  get enabled(): boolean {
    return this.account !== null;
  }

  // -------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------

  async register(userId: string, token: string, platform: 'android' | 'ios', app: 'rider' | 'driver') {
    await this.db.query(
      `INSERT INTO device_tokens (token, user_id, platform, app)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (token) DO UPDATE
         SET user_id = EXCLUDED.user_id, platform = EXCLUDED.platform,
             app = EXCLUDED.app, last_seen = now()`,
      [token, userId, platform, app],
    );
    return { ok: true };
  }

  async unregister(userId: string, token: string) {
    await this.db.query(`DELETE FROM device_tokens WHERE token = $1 AND user_id = $2`, [token, userId]);
    return { ok: true };
  }

  // -------------------------------------------------------------------
  // Sending
  // -------------------------------------------------------------------

  /** Fire-and-forget safe: never throws, so callers need not guard it. */
  async sendToUser(userId: string, message: PushMessage, app?: 'rider' | 'driver'): Promise<void> {
    try {
      if (!this.account) {
        if (!this.warned) {
          this.warned = true;
          this.logger.warn('FCM_SERVICE_ACCOUNT_JSON not set — push notifications are disabled');
        }
        return;
      }
      const rows: Array<{ token: string; lang: string }> = await this.db.query(
        `SELECT t.token, COALESCE(u.preferred_language, '') AS lang
           FROM device_tokens t JOIN users u ON u.id = t.user_id
          WHERE t.user_id = $1 AND ($2::text IS NULL OR t.app = $2)`,
        [userId, app ?? null],
      );
      if (!rows.length) return;
      const access = await this.accessToken();
      await Promise.all(rows.map((r) => this.sendOne(access, r.token, r.lang, message)));
    } catch (err: any) {
      this.logger.warn(`push to ${userId} failed: ${err?.message}`);
    }
  }

  private async sendOne(access: string, token: string, lang: string, m: PushMessage) {
    const url = `https://fcm.googleapis.com/v1/projects/${this.account!.project_id}/messages:send`;
    try {
      await firstValueFrom(
        this.http
          .post(
            url,
            {
              message: {
                token,
                notification: {
                  title: msg(m.title, lang, m.params),
                  body: m.bodyText ?? (m.body ? msg(m.body, lang, m.params) : ''),
                },
                data: m.data ?? {},
                android: { priority: 'HIGH', notification: { channel_id: 'kwema_default' } },
                apns: { headers: { 'apns-priority': '10' }, payload: { aps: { sound: 'default' } } },
              },
            },
            { headers: { Authorization: `Bearer ${access}` } },
          )
          .pipe(timeout(8_000)),
      );
    } catch (err: any) {
      const status = err?.response?.data?.error?.status;
      // A dead token is routine (app uninstalled). Drop it so we stop paying
      // for it; anything else is logged and left alone.
      if (status === 'NOT_FOUND' || status === 'UNREGISTERED' || status === 'INVALID_ARGUMENT') {
        await this.db.query(`DELETE FROM device_tokens WHERE token = $1`, [token]);
      } else {
        this.logger.warn(`fcm send failed: ${err?.message}`);
      }
    }
  }

  private async accessToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (this.cached && this.cached.expiresAt - 60 > now) return this.cached.token;

    const acct = this.account!;
    const tokenUri = acct.token_uri ?? 'https://oauth2.googleapis.com/token';
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned =
      b64({ alg: 'RS256', typ: 'JWT' }) +
      '.' +
      b64({
        iss: acct.client_email,
        scope: 'https://www.googleapis.com/auth/firebase.messaging',
        aud: tokenUri,
        iat: now,
        exp: now + 3600,
      });
    const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(acct.private_key).toString('base64url');

    const res = await firstValueFrom(
      this.http
        .post(
          tokenUri,
          new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion: `${unsigned}.${signature}`,
          }).toString(),
          { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
        )
        .pipe(timeout(8_000)),
    );
    this.cached = { token: res.data.access_token, expiresAt: now + Number(res.data.expires_in ?? 3600) };
    return this.cached.token;
  }
}
