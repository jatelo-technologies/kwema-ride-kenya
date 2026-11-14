/**
 * Cash-commission debt ceiling, shared by dispatch (who may receive offers)
 * and the cash service (who is shown as blocked), so the two can never
 * disagree about the same driver.
 *
 * The base and the cap come from the country profile (src/common/country.ts),
 * plus a little headroom per completed trip. Amounts are in cents.
 */
import { country } from './country';

export const BASE_DEBT_CEILING_CENTS = country.cashDebtCeilingCents;
/** 50 currency units of headroom per completed trip. */
export const HEADROOM_PER_TRIP_CENTS = 5_000;
export const MAX_DEBT_CEILING_CENTS = country.cashDebtMaxCeilingCents;

export function debtCeilingFor(completedTrips: number): number {
  return Math.min(
    BASE_DEBT_CEILING_CENTS + Math.max(0, completedTrips) * HEADROOM_PER_TRIP_CENTS,
    MAX_DEBT_CEILING_CENTS,
  );
}

/**
 * Whether a driver over their debt line stops receiving offers. Off by
 * default while the platform is being tested end to end; set
 * ENFORCE_DEBT_LIMIT=true on the server when going live. Debt is still
 * tracked and shown either way.
 */
export function debtLimitEnforced(): boolean {
  return String(process.env.ENFORCE_DEBT_LIMIT ?? '').toLowerCase() === 'true';
}
