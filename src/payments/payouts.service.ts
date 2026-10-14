/**
 * Automatic driver payouts.
 *
 * recordPayout() (earnings module) already moves the wallet and writes a
 * `pending` settlement row: that is the ledger. This service turns a pending
 * row into actual money by calling the wallet operator, then closes the row
 * when the operator confirms.
 *
 * Failure handling is the point of this file:
 *  * An HTTP error or timeout does NOT mark the payout failed. The operator
 *    may have accepted it. The row stays `pending` for an admin to retry or
 *    to check with `refresh`, rather than risking a double payment.
 *  * Only an explicit operator "failed" returns the money to the wallet, in
 *    the same transaction that marks the row failed.
 */

import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import Redis from 'ioredis';

import { REDIS } from '../common/redis.module';
import { MpesaProvider, MtnMomoProvider, AirtelMoneyProvider, MobileMoneyProvider } from './mobile-money.providers';
import { country } from '../common/country';

export type PayoutWallet = 'mpesa' | 'mtnmomo' | 'airtelmoney';

@Injectable()
export class PayoutsService {
  private readonly logger = new Logger(PayoutsService.name);

  constructor(
    private readonly db: DataSource,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly mpesa: MpesaProvider,
    private readonly mtnmomo: MtnMomoProvider,
    private readonly airtelmoney: AirtelMoneyProvider,
  ) {}

  private provider(wallet: PayoutWallet): MobileMoneyProvider {
    switch (wallet) {
      case 'mpesa': return this.mpesa;
      case 'mtnmomo': return this.mtnmomo;
      case 'airtelmoney': return this.airtelmoney;
    }
  }

  /** Payouts that still need action: not yet sent, or sent and unconfirmed. */
  async open() {
    return this.db.query(
      `SELECT s.id, s.external_reference, s.amount_cents, s.status, s.provider,
              s.created_at, u.full_name, u.phone
         FROM driver_settlements s
         JOIN drivers d ON d.id = s.driver_id
         JOIN users u ON u.id = d.user_id
        WHERE s.direction = 'disbursement' AND s.status IN ('pending', 'processing')
        ORDER BY s.created_at ASC
        LIMIT 200`,
    );
  }

  /** Sends a pending payout to the driver's wallet. */
  async send(settlementId: string, wallet: PayoutWallet) {
    // Refuse before claiming: nothing was sent, so nothing needs undoing.
    if (!country.mobileNetworks.includes(wallet)) {
      throw new BadRequestException(`${wallet} is not available in ${country.name}`);
    }
    if (!this.provider(wallet).canDisburse()) {
      throw new BadRequestException(`${wallet} payouts are not configured on this server`);
    }
    // Claim the row first so two admins pressing Send cannot both pay.
    const claimed = await this.db.query(
      `UPDATE driver_settlements
          SET status = 'processing', provider = $2::mno
        WHERE id = $1 AND direction = 'disbursement' AND status = 'pending'
        RETURNING id, driver_id, amount_cents, external_reference`,
      [settlementId, wallet],
    );
    // typeorm returns [rows, count] for UPDATE ... RETURNING on pg
    const row = Array.isArray(claimed[0]) ? claimed[0][0] : claimed[0];
    if (!row) {
      throw new BadRequestException('payout is not pending (already sent, failed or unknown)');
    }

    const [driver] = await this.db.query(
      `SELECT u.phone, u.full_name FROM drivers d JOIN users u ON u.id = d.user_id WHERE d.id = $1`,
      [row.driver_id],
    );
    if (!driver) {
      await this.release(settlementId);
      throw new NotFoundException('driver not found');
    }

    try {
      const res = await this.provider(wallet).initiateDisbursement({
        externalReference: row.external_reference,
        amountCents: Number(row.amount_cents),
        payeePhone: driver.phone,
        narration: `${country.brand} driver payout`,
      });
      if (!res.accepted) {
        await this.fail(settlementId, res.message ?? 'rejected by operator');
        return { status: 'failed', reason: res.message ?? 'rejected by operator' };
      }
      return { status: 'processing', reference: row.external_reference, operatorId: res.aggregatorTxnId ?? null };
    } catch (err: any) {
      // Unknown outcome. Keep it `processing`: refresh() will settle it. Do
      // not return the money to the wallet and do not allow a blind re-send.
      this.logger.warn(`payout ${row.external_reference} outcome unknown: ${err?.message}`);
      return { status: 'processing', reference: row.external_reference, note: 'outcome unknown — use refresh' };
    }
  }

  /** Asks the operator what happened to a processing payout and closes it. */
  async refresh(settlementId: string) {
    const [row] = await this.db.query(
      `SELECT id, driver_id, amount_cents, external_reference, provider, status
         FROM driver_settlements WHERE id = $1 AND direction = 'disbursement'`,
      [settlementId],
    );
    if (!row) throw new NotFoundException('payout not found');
    if (row.status !== 'processing') return { status: row.status };

    const provider = this.provider(row.provider as PayoutWallet);
    const result = await provider.queryDisbursement(row.external_reference);

    if (result.status === 'success') {
      await this.db.query(
        `UPDATE driver_settlements
            SET status = 'success', settled_at = now(),
                mno_receipt = COALESCE($2, mno_receipt)
          WHERE id = $1 AND status = 'processing'`,
        [settlementId, result.mnoReceipt ?? null],
      );
      return { status: 'success', receipt: result.mnoReceipt ?? null };
    }
    if (result.status === 'failed') {
      await this.fail(settlementId, result.reason ?? 'failed at operator');
      return { status: 'failed', reason: result.reason ?? 'failed at operator' };
    }
    return { status: 'processing' };
  }

  /** Puts a claimed-but-unsent payout back to pending. */
  private async release(settlementId: string) {
    await this.db.query(
      `UPDATE driver_settlements SET status = 'pending', provider = NULL
        WHERE id = $1 AND status = 'processing'`,
      [settlementId],
    );
  }

  /** Marks the payout failed and returns the money to the driver's wallet. */
  private async fail(settlementId: string, reason: string) {
    await this.db.transaction(async (m) => {
      const [s] = await m.query(
        `UPDATE driver_settlements
            SET status = 'failed', failure_reason = $2, settled_at = now()
          WHERE id = $1 AND status = 'processing'
          RETURNING driver_id, amount_cents`,
        [settlementId, reason.slice(0, 500)],
      );
      const r = Array.isArray(s) ? s[0] : s;
      if (!r) return; // already closed by someone else
      const [d] = await m.query(
        `UPDATE drivers SET wallet_balance_cents = wallet_balance_cents + $2
          WHERE id = $1 RETURNING wallet_balance_cents`,
        [r.driver_id, r.amount_cents],
      );
      if (d) {
        await this.redis.hset(`driver:${r.driver_id}`, {
          walletBalanceCents: String(d.wallet_balance_cents),
        });
      }
    });
  }
}
