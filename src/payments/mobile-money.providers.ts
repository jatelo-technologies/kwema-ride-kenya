/**
 * Mobile money adapters for Kenya, Uganda and Rwanda.
 *
 *   M-Pesa (Safaricom Daraja)   Kenya      STK push collections, B2C payouts
 *   MTN Mobile Money (MoMo API) Uganda, Rwanda   request-to-pay, transfers
 *   Airtel Money (Open API)     Kenya, Uganda, Rwanda
 *
 * Each adapter speaks its operator's own authentication and request shapes
 * (OAuth bearer tokens, per-request references, STK prompts). They are written
 * from the operators' published API descriptions and have NOT been run against
 * a live or sandbox account: field names, paths and response codes must be
 * reconciled against the merchant pack each operator issues. Paths that were
 * least certain are overridable through environment variables.
 *
 * The security properties are what must survive that reconciliation:
 *
 *  1. Callbacks from these operators are NOT signed. A callback is therefore
 *     only a hint. It must carry our secret token (in the callback URL we
 *     register), and its content is never trusted: the service re-queries the
 *     operator for the real outcome before touching any ledger
 *     (`confirmWithProvider`).
 *  2. A timeout or 5xx never means "failed". The customer's phone may already
 *     be prompting, or a payout may already be on its way. Unknown outcomes
 *     stay `processing` and are settled by status queries.
 *  3. Payouts are never retried automatically.
 *  4. Our references are the idempotency keys.
 */

import { Injectable, Inject, Logger, ServiceUnavailableException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom, timeout } from 'rxjs';
import Redis from 'ioredis';
import * as crypto from 'node:crypto';

import { REDIS } from '../common/redis.module';
import { country } from '../common/country';

export type Mno = 'mpesa' | 'mtnmomo' | 'airtelmoney';
export type ProviderName = Mno;

/** URL segments used for callbacks. Safaricom rejects callback URLs that
 *  contain the word "mpesa", so no segment is derived from a brand name. */
export const PROVIDER_SLUGS: Record<string, ProviderName> = {
  daraja: 'mpesa',
  momo: 'mtnmomo',
  airtel: 'airtelmoney',
};

export function slugFor(name: ProviderName): string {
  return Object.keys(PROVIDER_SLUGS).find((s) => PROVIDER_SLUGS[s] === name)!;
}

export interface CollectionRequest {
  /** Our unique reference; also the idempotency key. */
  externalReference: string;
  amountCents: number;
  /** E.164, e.g. +254XXXXXXXXX. */
  payerPhone: string;
  mno: Mno;
  rideReference: string;
  /** Shown on the customer's handset during the prompt. */
  narration: string;
}

export interface CollectionResult {
  accepted: boolean;
  aggregatorTxnId?: string;
  message?: string;
  raw: unknown;
}

export interface WebhookVerification {
  valid: boolean;
  externalReference?: string;
  status?: 'success' | 'failed' | 'pending';
  mnoReceipt?: string;
  amountCents?: number;
  reason?: string;
  /** The operator's own id for the payment (needed to query it). */
  aggregatorTxnId?: string;
  /**
   * True for unsigned callbacks. The payment service must ask the operator
   * for the outcome and use THAT answer; the fields above are hints only.
   */
  confirmWithProvider?: boolean;
}

export interface DisbursementRequest {
  externalReference: string;
  amountCents: number;
  /** E.164 recipient wallet number. */
  payeePhone: string;
  narration: string;
}

export interface MobileMoneyProvider {
  readonly name: ProviderName;
  /** Collections: credentials present. */
  isConfigured(): boolean;
  /** Payouts: credentials present. */
  canDisburse(): boolean;
  initiateCollection(req: CollectionRequest): Promise<CollectionResult>;
  verifyWebhook(headers: Record<string, string>, rawBody: Buffer): WebhookVerification;
  queryStatus(externalReference: string, aggregatorTxnId?: string): Promise<WebhookVerification>;
  initiateDisbursement(req: DisbursementRequest): Promise<CollectionResult>;
  queryDisbursement(externalReference: string): Promise<WebhookVerification>;
}

// =====================================================================
// Shared helpers
// =====================================================================

/** MSISDN with country code, no plus sign: 2547XXXXXXXX. */
function intlMsisdn(e164: string): string {
  return e164.replace(/^\+/, '');
}

/** MSISDN without the country code: 7XXXXXXXX. */
function nationalMsisdn(e164: string): string {
  return e164.replace(/^\+/, '').replace(new RegExp(`^${country.dialCode}`), '');
}

/** Whole currency units (no operator here takes cents). At least 1. */
function wholeUnits(cents: number): number {
  return Math.max(1, Math.round(cents / 100));
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** Deterministic UUID v4-shaped id from our reference (MTN needs a UUID, and
 *  the same reference must always map to the same one for idempotency). */
function uuidFromReference(ref: string): string {
  const h = crypto.createHash('sha256').update(`ref:${ref}`).digest('hex');
  const v = ((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${v}${h.slice(18, 20)}-${h.slice(20, 32)}`;
}

/** PEM text from an env var: accepts real newlines, "\n" escapes or base64. */
function pemFromEnv(raw: string): string {
  if (!raw) return '';
  if (raw.includes('-----BEGIN')) return raw.replace(/\\n/g, '\n');
  return Buffer.from(raw, 'base64').toString('utf8');
}

/** Public base URL operators call back to. */
function callbackBase(specific: string): string {
  return (specific || process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
}

/** True when the operator answered and refused (4xx): safe to call it failed.
 *  No answer, or a 5xx, is an unknown outcome. */
function isExplicitRejection(err: any): boolean {
  const s = err?.response?.status;
  return typeof s === 'number' && s >= 400 && s < 500;
}

function errorMessage(err: any): string {
  const d = err?.response?.data;
  return (
    d?.errorMessage ?? d?.message ?? d?.error_description ?? d?.status?.message ??
    d?.ResponseDescription ?? err?.message ?? 'rejected'
  );
}

/** Caches an access token and shares one in-flight refresh between callers. */
class TokenCache {
  private value?: string;
  private expiresAt = 0;
  private inflight?: Promise<string>;

  async get(fetcher: () => Promise<{ token: string; ttlSeconds: number }>): Promise<string> {
    if (this.value && Date.now() < this.expiresAt) return this.value;
    if (!this.inflight) {
      this.inflight = fetcher()
        .then(({ token, ttlSeconds }) => {
          this.value = token;
          // Refresh a minute early so a token never expires mid-request.
          this.expiresAt = Date.now() + Math.max(30, ttlSeconds - 60) * 1000;
          return token;
        })
        .finally(() => { this.inflight = undefined; });
    }
    return this.inflight;
  }

  clear() { this.value = undefined; this.expiresAt = 0; }
}

abstract class BaseProvider {
  protected readonly logger = new Logger(this.constructor.name);
  constructor(protected readonly http: HttpService) {}

  protected checkToken(headers: Record<string, string>, expected: string): boolean {
    const given = headers['x-callback-token'] ?? '';
    return !!expected && !!given && safeEqual(given, expected);
  }
}

// =====================================================================
// M-Pesa — Safaricom Daraja (Kenya)
// =====================================================================

@Injectable()
export class MpesaProvider extends BaseProvider implements MobileMoneyProvider {
  readonly name = 'mpesa' as const;
  private readonly tokens = new TokenCache();

  constructor(http: HttpService, @Inject(REDIS) private readonly redis: Redis) { super(http); }

  private env(key: string): string { return process.env[`MPESA_${key}`] ?? ''; }

  isConfigured(): boolean {
    return !!(this.env('BASE_URL') && this.env('CONSUMER_KEY') && this.env('CONSUMER_SECRET') &&
      this.env('SHORTCODE') && this.env('PASSKEY') && this.env('CALLBACK_TOKEN') &&
      callbackBase(this.env('CALLBACK_BASE')));
  }

  canDisburse(): boolean {
    return !!(this.isConfigured() && this.env('INITIATOR_NAME') && this.env('INITIATOR_PASSWORD') &&
      this.env('CERT_PEM') && (this.env('B2C_SHORTCODE') || this.env('SHORTCODE')));
  }

  private async token(): Promise<string> {
    return this.tokens.get(async () => {
      const basic = Buffer.from(`${this.env('CONSUMER_KEY')}:${this.env('CONSUMER_SECRET')}`).toString('base64');
      const res = await firstValueFrom(
        this.http
          .get(`${this.env('BASE_URL')}/oauth/v1/generate?grant_type=client_credentials`, {
            headers: { Authorization: `Basic ${basic}` },
          })
          .pipe(timeout(15_000)),
      );
      return { token: res.data.access_token, ttlSeconds: Number(res.data.expires_in ?? 3599) };
    });
  }

  /** Daraja timestamps are East Africa Time: yyyyMMddHHmmss. */
  private timestamp(): string {
    const d = new Date(Date.now() + 3 * 3600_000);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
  }

  private password(ts: string): string {
    return Buffer.from(`${this.env('SHORTCODE')}${this.env('PASSKEY')}${ts}`).toString('base64');
  }

  private callbackUrl(path: string, ref?: string): string {
    const q = new URLSearchParams({ t: this.env('CALLBACK_TOKEN') });
    if (ref) q.set('ref', ref);
    return `${callbackBase(this.env('CALLBACK_BASE'))}/api/payments/${path}/${slugFor('mpesa')}?${q}`;
  }

  async initiateCollection(req: CollectionRequest): Promise<CollectionResult> {
    const ts = this.timestamp();
    const body = {
      BusinessShortCode: this.env('SHORTCODE'),
      Password: this.password(ts),
      Timestamp: ts,
      // CustomerPayBillOnline for a Paybill, CustomerBuyGoodsOnline for a Till.
      TransactionType: this.env('TXN_TYPE') || 'CustomerPayBillOnline',
      Amount: wholeUnits(req.amountCents),
      PartyA: intlMsisdn(req.payerPhone),
      PartyB: this.env('PARTY_B') || this.env('SHORTCODE'),
      PhoneNumber: intlMsisdn(req.payerPhone),
      CallBackURL: this.callbackUrl('webhook', req.externalReference),
      AccountReference: req.rideReference.slice(0, 12),
      TransactionDesc: req.narration.slice(0, 20),
    };
    try {
      const token = await this.token();
      const res = await firstValueFrom(
        this.http
          .post(`${this.env('BASE_URL')}/mpesa/stkpush/v1/processrequest`, body, {
            headers: { Authorization: `Bearer ${token}` },
          })
          // No automatic retry: the handset may already be prompting.
          .pipe(timeout(25_000)),
      );
      const ok = String(res.data?.ResponseCode) === '0';
      return {
        accepted: ok,
        aggregatorTxnId: res.data?.CheckoutRequestID,
        message: ok ? undefined : res.data?.ResponseDescription,
        raw: res.data,
      };
    } catch (err: any) {
      if (err?.response?.status === 401) this.tokens.clear();
      if (isExplicitRejection(err)) {
        return { accepted: false, message: errorMessage(err), raw: err.response?.data };
      }
      this.logger.error(`mpesa collection unknown outcome ref=${req.externalReference}: ${err?.message}`);
      throw new ServiceUnavailableException('mobile money provider unavailable');
    }
  }

  verifyWebhook(headers: Record<string, string>, rawBody: Buffer): WebhookVerification {
    if (!this.checkToken(headers, this.env('CALLBACK_TOKEN'))) {
      return { valid: false, reason: 'bad_token' };
    }
    const ref = headers['x-callback-ref'];
    if (!ref) return { valid: false, reason: 'no_reference' };
    let cb: any;
    try { cb = JSON.parse(rawBody.toString('utf8'))?.Body?.stkCallback; } catch { /* below */ }
    if (!cb) return { valid: false, reason: 'bad_body' };

    const items: any[] = cb.CallbackMetadata?.Item ?? [];
    const pick = (name: string) => items.find((i) => i?.Name === name)?.Value;
    const amount = pick('Amount');
    return {
      valid: true,
      externalReference: ref,
      status: Number(cb.ResultCode) === 0 ? 'success' : 'failed',
      mnoReceipt: pick('MpesaReceiptNumber'),
      amountCents: amount !== undefined ? Math.round(Number(amount) * 100) : undefined,
      aggregatorTxnId: cb.CheckoutRequestID,
      reason: cb.ResultDesc,
      confirmWithProvider: true,
    };
  }

  async queryStatus(externalReference: string, aggregatorTxnId?: string): Promise<WebhookVerification> {
    // Without the operator's checkout id there is nothing to query.
    if (!aggregatorTxnId) return { valid: true, externalReference, status: 'pending' };
    const ts = this.timestamp();
    try {
      const token = await this.token();
      const res = await firstValueFrom(
        this.http
          .post(`${this.env('BASE_URL')}/mpesa/stkpushquery/v1/query`, {
            BusinessShortCode: this.env('SHORTCODE'),
            Password: this.password(ts),
            Timestamp: ts,
            CheckoutRequestID: aggregatorTxnId,
          }, { headers: { Authorization: `Bearer ${token}` } })
          .pipe(timeout(15_000)),
      );
      const code = Number(res.data?.ResultCode);
      return {
        valid: true,
        externalReference,
        status: code === 0 ? 'success' : 'failed',
        reason: res.data?.ResultDesc,
        aggregatorTxnId,
      };
    } catch (err: any) {
      // Daraja answers an unfinished prompt with an error, not a status.
      if (err?.response?.data?.errorCode === '500.001.1001') {
        return { valid: true, externalReference, status: 'pending', aggregatorTxnId };
      }
      throw err;
    }
  }

  /** B2C payout. The outcome arrives on ResultURL; see recordPayoutResult. */
  async initiateDisbursement(req: DisbursementRequest): Promise<CollectionResult> {
    const credential = crypto.publicEncrypt(
      { key: pemFromEnv(this.env('CERT_PEM')), padding: crypto.constants.RSA_PKCS1_PADDING },
      Buffer.from(this.env('INITIATOR_PASSWORD')),
    ).toString('base64');
    const body = {
      OriginatorConversationID: req.externalReference,
      InitiatorName: this.env('INITIATOR_NAME'),
      SecurityCredential: credential,
      CommandID: this.env('B2C_COMMAND') || 'BusinessPayment',
      Amount: wholeUnits(req.amountCents),
      PartyA: this.env('B2C_SHORTCODE') || this.env('SHORTCODE'),
      PartyB: intlMsisdn(req.payeePhone),
      Remarks: req.narration.slice(0, 100),
      QueueTimeOutURL: this.callbackUrl('payout-timeout'),
      ResultURL: this.callbackUrl('payout-result'),
      Occassion: req.externalReference.slice(0, 100), // sic: Daraja's spelling
    };
    try {
      const token = await this.token();
      const res = await firstValueFrom(
        this.http
          .post(`${this.env('BASE_URL')}${this.env('B2C_PATH') || '/mpesa/b2c/v3/paymentrequest'}`, body, {
            headers: { Authorization: `Bearer ${token}` },
          })
          // Never retried: a repeated payout is money leaving twice.
          .pipe(timeout(25_000)),
      );
      const ok = String(res.data?.ResponseCode) === '0';
      return {
        accepted: ok,
        aggregatorTxnId: res.data?.ConversationID,
        message: ok ? undefined : res.data?.ResponseDescription,
        raw: res.data,
      };
    } catch (err: any) {
      if (isExplicitRejection(err)) {
        return { accepted: false, message: errorMessage(err), raw: err.response?.data };
      }
      this.logger.error(`mpesa payout unknown outcome ref=${req.externalReference}: ${err?.message}`);
      throw new ServiceUnavailableException('mobile money provider unavailable');
    }
  }

  /** Called by the payout-result route. Stores the definitive B2C outcome. */
  async recordPayoutResult(headers: Record<string, string>, rawBody: Buffer): Promise<boolean> {
    if (!this.checkToken(headers, this.env('CALLBACK_TOKEN'))) return false;
    let r: any;
    try { r = JSON.parse(rawBody.toString('utf8'))?.Result; } catch { return false; }
    const ref = r?.OriginatorConversationID;
    if (!ref) return false;
    const params: any[] = r.ResultParameters?.ResultParameter ?? [];
    const receipt = r.TransactionID ?? params.find((p) => p?.Key === 'TransactionReceipt')?.Value;
    const outcome = {
      status: Number(r.ResultCode) === 0 ? 'success' : 'failed',
      receipt: receipt ?? null,
      reason: r.ResultDesc ?? null,
    };
    await this.redis.set(`mpesa:b2c:${ref}`, JSON.stringify(outcome), 'EX', 60 * 60 * 24 * 30);
    return true;
  }

  async queryDisbursement(externalReference: string): Promise<WebhookVerification> {
    const stored = await this.redis.get(`mpesa:b2c:${externalReference}`);
    // No result yet: still pending. The queue-timeout callback is NOT a
    // failure (the payment may still complete), so it is never recorded.
    if (!stored) return { valid: true, externalReference, status: 'pending' };
    const o = JSON.parse(stored);
    return { valid: true, externalReference, status: o.status, mnoReceipt: o.receipt ?? undefined, reason: o.reason ?? undefined };
  }
}

// =====================================================================
// MTN Mobile Money — MoMo Open API (Uganda, Rwanda)
// =====================================================================

@Injectable()
export class MtnMomoProvider extends BaseProvider implements MobileMoneyProvider {
  readonly name = 'mtnmomo' as const;
  private readonly collectionTokens = new TokenCache();
  private readonly disbursementTokens = new TokenCache();

  constructor(http: HttpService) { super(http); }

  private env(key: string): string { return process.env[`MTN_${key}`] ?? ''; }

  private base(): { url: string; target: string; currency: string } {
    return {
      url: this.env('BASE_URL'),
      // 'sandbox' in testing; the live value is given by MTN per country.
      target: this.env('TARGET_ENV') || 'sandbox',
      currency: this.env('CURRENCY') || country.currency,
    };
  }

  isConfigured(): boolean {
    return !!(this.env('BASE_URL') && this.env('COLLECTION_KEY') && this.env('COLLECTION_USER') &&
      this.env('COLLECTION_SECRET') && this.env('CALLBACK_TOKEN') && callbackBase(this.env('CALLBACK_BASE')));
  }

  canDisburse(): boolean {
    return !!(this.env('BASE_URL') && this.env('DISBURSE_KEY') && this.env('DISBURSE_USER') && this.env('DISBURSE_SECRET'));
  }

  private async token(product: 'collection' | 'disbursement'): Promise<string> {
    const cache = product === 'collection' ? this.collectionTokens : this.disbursementTokens;
    const p = product === 'collection' ? 'COLLECTION' : 'DISBURSE';
    return cache.get(async () => {
      const basic = Buffer.from(`${this.env(`${p}_USER`)}:${this.env(`${p}_SECRET`)}`).toString('base64');
      const res = await firstValueFrom(
        this.http
          .post(`${this.base().url}/${product}/token/`, null, {
            headers: { Authorization: `Basic ${basic}`, 'Ocp-Apim-Subscription-Key': this.env(`${p}_KEY`) },
          })
          .pipe(timeout(15_000)),
      );
      return { token: res.data.access_token, ttlSeconds: Number(res.data.expires_in ?? 3600) };
    });
  }

  private headers(product: 'collection' | 'disbursement', token: string, extra: Record<string, string> = {}) {
    const p = product === 'collection' ? 'COLLECTION' : 'DISBURSE';
    return {
      Authorization: `Bearer ${token}`,
      'X-Target-Environment': this.base().target,
      'Ocp-Apim-Subscription-Key': this.env(`${p}_KEY`),
      'Content-Type': 'application/json',
      ...extra,
    };
  }

  async initiateCollection(req: CollectionRequest): Promise<CollectionResult> {
    const id = uuidFromReference(req.externalReference);
    const q = new URLSearchParams({ t: this.env('CALLBACK_TOKEN'), ref: req.externalReference });
    const callback = `${callbackBase(this.env('CALLBACK_BASE'))}/api/payments/webhook/${slugFor('mtnmomo')}?${q}`;
    try {
      const token = await this.token('collection');
      await firstValueFrom(
        this.http
          .post(`${this.base().url}/collection/v1_0/requesttopay`, {
            amount: String(wholeUnits(req.amountCents)),
            currency: this.base().currency,
            externalId: req.externalReference,
            payer: { partyIdType: 'MSISDN', partyId: intlMsisdn(req.payerPhone) },
            payerMessage: req.narration.slice(0, 160),
            payeeNote: req.rideReference,
          }, {
            headers: this.headers('collection', token, { 'X-Reference-Id': id, 'X-Callback-Url': callback }),
          })
          .pipe(timeout(25_000)),
      );
      return { accepted: true, aggregatorTxnId: id, raw: { referenceId: id } };
    } catch (err: any) {
      if (err?.response?.status === 401) this.collectionTokens.clear();
      // 409: this reference was already submitted. That is our idempotency
      // key doing its job, not a failure.
      if (err?.response?.status === 409) return { accepted: true, aggregatorTxnId: id, raw: { referenceId: id, duplicate: true } };
      if (isExplicitRejection(err)) {
        return { accepted: false, message: errorMessage(err), raw: err.response?.data };
      }
      this.logger.error(`mtn collection unknown outcome ref=${req.externalReference}: ${err?.message}`);
      throw new ServiceUnavailableException('mobile money provider unavailable');
    }
  }

  private mapStatus(s: unknown): 'success' | 'failed' | 'pending' {
    const v = String(s ?? '').toUpperCase();
    if (v === 'SUCCESSFUL') return 'success';
    if (v === 'PENDING' || v === '') return 'pending';
    return 'failed';
  }

  verifyWebhook(headers: Record<string, string>, rawBody: Buffer): WebhookVerification {
    if (!this.checkToken(headers, this.env('CALLBACK_TOKEN'))) return { valid: false, reason: 'bad_token' };
    let body: any;
    try { body = JSON.parse(rawBody.toString('utf8')); } catch { return { valid: false, reason: 'bad_body' }; }
    const ref = headers['x-callback-ref'] || body?.externalId;
    if (!ref) return { valid: false, reason: 'no_reference' };
    return {
      valid: true,
      externalReference: ref,
      status: this.mapStatus(body.status),
      mnoReceipt: body.financialTransactionId,
      amountCents: body.amount !== undefined ? Math.round(Number(body.amount) * 100) : undefined,
      reason: typeof body.reason === 'string' ? body.reason : body.reason?.message,
      confirmWithProvider: true,
    };
  }

  async queryStatus(externalReference: string): Promise<WebhookVerification> {
    const token = await this.token('collection');
    const res = await firstValueFrom(
      this.http
        .get(`${this.base().url}/collection/v1_0/requesttopay/${uuidFromReference(externalReference)}`, {
          headers: this.headers('collection', token),
        })
        .pipe(timeout(15_000)),
    );
    return {
      valid: true,
      externalReference,
      status: this.mapStatus(res.data?.status),
      mnoReceipt: res.data?.financialTransactionId,
      amountCents: res.data?.amount !== undefined ? Math.round(Number(res.data.amount) * 100) : undefined,
      reason: typeof res.data?.reason === 'string' ? res.data.reason : res.data?.reason?.message,
    };
  }

  async initiateDisbursement(req: DisbursementRequest): Promise<CollectionResult> {
    const id = uuidFromReference(req.externalReference);
    try {
      const token = await this.token('disbursement');
      await firstValueFrom(
        this.http
          .post(`${this.base().url}/disbursement/v1_0/transfer`, {
            amount: String(wholeUnits(req.amountCents)),
            currency: this.base().currency,
            externalId: req.externalReference,
            payee: { partyIdType: 'MSISDN', partyId: intlMsisdn(req.payeePhone) },
            payerMessage: req.narration.slice(0, 160),
            payeeNote: req.narration.slice(0, 160),
          }, { headers: this.headers('disbursement', token, { 'X-Reference-Id': id }) })
          .pipe(timeout(25_000)),
      );
      return { accepted: true, aggregatorTxnId: id, raw: { referenceId: id } };
    } catch (err: any) {
      if (err?.response?.status === 401) this.disbursementTokens.clear();
      if (err?.response?.status === 409) return { accepted: true, aggregatorTxnId: id, raw: { duplicate: true } };
      if (isExplicitRejection(err)) {
        return { accepted: false, message: errorMessage(err), raw: err.response?.data };
      }
      this.logger.error(`mtn payout unknown outcome ref=${req.externalReference}: ${err?.message}`);
      throw new ServiceUnavailableException('mobile money provider unavailable');
    }
  }

  async queryDisbursement(externalReference: string): Promise<WebhookVerification> {
    const token = await this.token('disbursement');
    const res = await firstValueFrom(
      this.http
        .get(`${this.base().url}/disbursement/v1_0/transfer/${uuidFromReference(externalReference)}`, {
          headers: this.headers('disbursement', token),
        })
        .pipe(timeout(15_000)),
    );
    return {
      valid: true,
      externalReference,
      status: this.mapStatus(res.data?.status),
      mnoReceipt: res.data?.financialTransactionId,
      reason: typeof res.data?.reason === 'string' ? res.data.reason : res.data?.reason?.message,
    };
  }
}

// =====================================================================
// Airtel Money — Airtel Africa Open API (Kenya, Uganda, Rwanda)
// =====================================================================

@Injectable()
export class AirtelMoneyProvider extends BaseProvider implements MobileMoneyProvider {
  readonly name = 'airtelmoney' as const;
  private readonly tokens = new TokenCache();

  constructor(http: HttpService) { super(http); }

  private env(key: string): string { return process.env[`AIRTEL_${key}`] ?? ''; }

  private cc(): string { return this.env('COUNTRY') || country.code; }
  private currency(): string { return this.env('CURRENCY') || country.currency; }

  isConfigured(): boolean {
    return !!(this.env('BASE_URL') && this.env('CLIENT_ID') && this.env('CLIENT_SECRET') && this.env('CALLBACK_TOKEN'));
  }

  canDisburse(): boolean {
    return !!(this.isConfigured() && this.env('PIN') && this.env('PUBLIC_KEY'));
  }

  private async token(): Promise<string> {
    return this.tokens.get(async () => {
      const res = await firstValueFrom(
        this.http
          .post(`${this.env('BASE_URL')}/auth/oauth2/token`, {
            client_id: this.env('CLIENT_ID'),
            client_secret: this.env('CLIENT_SECRET'),
            grant_type: 'client_credentials',
          }, { headers: { 'Content-Type': 'application/json', Accept: '*/*' } })
          .pipe(timeout(15_000)),
      );
      return { token: res.data.access_token, ttlSeconds: Number(res.data.expires_in ?? 180) };
    });
  }

  private headers(token: string) {
    return {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: '*/*',
      'X-Country': this.cc(),
      'X-Currency': this.currency(),
    };
  }

  private mapStatus(code: unknown): 'success' | 'failed' | 'pending' {
    const v = String(code ?? '').toUpperCase();
    if (v === 'TS') return 'success';
    // TIP in progress, TA ambiguous: do not decide, ask again later.
    if (v === 'TIP' || v === 'TA' || v === '') return 'pending';
    return 'failed'; // TF failed, TE expired
  }

  async initiateCollection(req: CollectionRequest): Promise<CollectionResult> {
    try {
      const token = await this.token();
      const res = await firstValueFrom(
        this.http
          .post(`${this.env('BASE_URL')}/merchant/v1/payments/`, {
            reference: req.narration.slice(0, 64),
            subscriber: { country: this.cc(), currency: this.currency(), msisdn: nationalMsisdn(req.payerPhone) },
            transaction: { amount: wholeUnits(req.amountCents), country: this.cc(), currency: this.currency(), id: req.externalReference },
          }, { headers: this.headers(token) })
          .pipe(timeout(25_000)),
      );
      const ok = res.data?.status?.success === true;
      return {
        accepted: ok,
        aggregatorTxnId: res.data?.data?.transaction?.id ?? req.externalReference,
        message: ok ? undefined : res.data?.status?.message,
        raw: res.data,
      };
    } catch (err: any) {
      if (err?.response?.status === 401) this.tokens.clear();
      if (isExplicitRejection(err)) {
        return { accepted: false, message: errorMessage(err), raw: err.response?.data };
      }
      this.logger.error(`airtel collection unknown outcome ref=${req.externalReference}: ${err?.message}`);
      throw new ServiceUnavailableException('mobile money provider unavailable');
    }
  }

  verifyWebhook(headers: Record<string, string>, rawBody: Buffer): WebhookVerification {
    // Airtel has one callback URL per app, set in its portal, so the token is
    // part of that registered URL and the reference comes from the body.
    if (!this.checkToken(headers, this.env('CALLBACK_TOKEN'))) return { valid: false, reason: 'bad_token' };
    let body: any;
    try { body = JSON.parse(rawBody.toString('utf8')); } catch { return { valid: false, reason: 'bad_body' }; }
    const t = body?.transaction;
    if (!t?.id) return { valid: false, reason: 'no_reference' };
    return {
      valid: true,
      externalReference: t.id,
      status: this.mapStatus(t.status_code),
      mnoReceipt: t.airtel_money_id,
      reason: t.message,
      confirmWithProvider: true,
    };
  }

  async queryStatus(externalReference: string): Promise<WebhookVerification> {
    const token = await this.token();
    const res = await firstValueFrom(
      this.http
        .get(`${this.env('BASE_URL')}/standard/v1/payments/${encodeURIComponent(externalReference)}`, {
          headers: this.headers(token),
        })
        .pipe(timeout(15_000)),
    );
    const t = res.data?.data?.transaction;
    return {
      valid: true,
      externalReference,
      status: this.mapStatus(t?.status),
      mnoReceipt: t?.airtel_money_id ?? t?.id,
      reason: t?.message,
    };
  }

  /** PIN encrypted with the RSA key Airtel issues. Padding is configurable
   *  because the integration pack decides it (default PKCS#1 v1.5). */
  private encryptedPin(): string {
    const padding = (this.env('PIN_PADDING') || 'pkcs1').toLowerCase() === 'oaep'
      ? crypto.constants.RSA_PKCS1_OAEP_PADDING
      : crypto.constants.RSA_PKCS1_PADDING;
    return crypto.publicEncrypt(
      { key: pemFromEnv(this.env('PUBLIC_KEY')), padding },
      Buffer.from(this.env('PIN')),
    ).toString('base64');
  }

  async initiateDisbursement(req: DisbursementRequest): Promise<CollectionResult> {
    try {
      const token = await this.token();
      const res = await firstValueFrom(
        this.http
          .post(`${this.env('BASE_URL')}${this.env('DISBURSE_PATH') || '/standard/v2/disbursements/'}`, {
            payee: { currency: this.currency(), msisdn: nationalMsisdn(req.payeePhone), name: 'Driver' },
            reference: req.narration.slice(0, 64),
            pin: this.encryptedPin(),
            transaction: { amount: wholeUnits(req.amountCents), id: req.externalReference, type: 'B2C' },
          }, { headers: this.headers(token) })
          // Never retried: a repeated payout is money leaving twice.
          .pipe(timeout(25_000)),
      );
      const ok = res.data?.status?.success === true;
      return {
        accepted: ok,
        aggregatorTxnId: res.data?.data?.transaction?.id ?? req.externalReference,
        message: ok ? undefined : res.data?.status?.message,
        raw: res.data,
      };
    } catch (err: any) {
      if (isExplicitRejection(err)) {
        return { accepted: false, message: errorMessage(err), raw: err.response?.data };
      }
      this.logger.error(`airtel payout unknown outcome ref=${req.externalReference}: ${err?.message}`);
      throw new ServiceUnavailableException('mobile money provider unavailable');
    }
  }

  async queryDisbursement(externalReference: string): Promise<WebhookVerification> {
    const token = await this.token();
    const path = (this.env('DISBURSE_STATUS_PATH') || '/standard/v1/disbursements/{id}')
      .replace('{id}', encodeURIComponent(externalReference));
    const res = await firstValueFrom(
      this.http.get(`${this.env('BASE_URL')}${path}`, { headers: this.headers(token) }).pipe(timeout(15_000)),
    );
    const t = res.data?.data?.transaction;
    return {
      valid: true,
      externalReference,
      status: this.mapStatus(t?.status),
      mnoReceipt: t?.airtel_money_id ?? t?.id,
      reason: t?.message,
    };
  }
}
