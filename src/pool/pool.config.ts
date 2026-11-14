/**
 * Car-pooling settings.
 *
 * Everything here is a business lever, so each one can be overridden with an
 * environment variable and no redeploy of code is needed to retune a city.
 *
 * Discount tiers
 *   POOL_DISCOUNT_BPS="2500,3500,4000" means: with one other rider on board
 *   at the same time, 25% off your fare; two others, 35%; three or more, 40%.
 *   Basis points, 10 000 = 100%. The discount is applied only when the
 *   sharing really happened, so a pooled rider nobody joined pays the normal
 *   fare for their own trip.
 */

import { VehicleCategory } from '../dispatch/dispatch.service';

function ints(raw: string | undefined, fallback: number[]): number[] {
  if (!raw) return fallback;
  const parts = raw.split(',').map((s) => Number.parseInt(s.trim(), 10));
  return parts.length > 0 && parts.every((n) => Number.isFinite(n) && n >= 0 && n <= 7000)
    ? parts
    : fallback;
}

function num(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return raw !== undefined && raw !== '' && Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Passenger seats a pooled vehicle offers, per category. A single-pillion
 * motorbike cannot be pooled, and express is a private, premium product.
 */
export const POOL_SEATS: Partial<Record<VehicleCategory, number>> = {
  bajaji: 2,
  e_bajaji: 2,
  standard: 3,
  e_car: 3,
  xl: 5,
};

export const POOL = {
  // Off in Kenya until the business decides to offer it: set POOL_ENABLED=true.
  enabled: process.env.POOL_ENABLED === 'true',

  /** Discount (bps) for 1, 2, 3+ other riders on board at the same time. */
  discountBps: ints(process.env.POOL_DISCOUNT_BPS, [2500, 3500, 4000]),

  /** How far a joining rider's pickup may sit from the trip's route. */
  pickupMaxM: num(process.env.POOL_PICKUP_MAX_M, 1500),
  /** How far their dropoff may sit from the trip's route. */
  dropoffMaxM: num(process.env.POOL_DROPOFF_MAX_M, 2000),
  /** Direction of travel must agree to within this many degrees. */
  bearingMaxDeg: num(process.env.POOL_BEARING_MAX_DEG, 50),
  /** A moving vehicle will not be sent further than this to a pickup. */
  driverToPickupMaxM: num(process.env.POOL_DRIVER_TO_PICKUP_MAX_M, 3500),
  /** Extra distance the driver may be asked to drive for one more rider. */
  detourMaxM: num(process.env.POOL_DETOUR_MAX_M, 1500),
  /** ...or this share of the remaining trip, whichever is larger (bps). */
  detourMaxBps: num(process.env.POOL_DETOUR_MAX_BPS, 3500),

  /** Live match: how many on-the-road trips a new rider is tried against. */
  liveMatchOffers: Math.floor(num(process.env.POOL_LIVE_MATCH_OFFERS, 2)),
  /** Shared trips returned by the browse list. */
  browseLimit: 15,
  /** A position older than this is not trusted for matching. */
  maxPingAgeMs: 45_000,
};

export function poolSeatsFor(category: string): number {
  return POOL_SEATS[category as VehicleCategory] ?? 0;
}

export function isPoolCategory(category: string): boolean {
  return poolSeatsFor(category) > 0;
}

/**
 * Discount for a rider who shared the vehicle with `others` other riders at
 * the same time. Zero others means no discount.
 */
export function discountBpsFor(others: number): number {
  if (others <= 0 || !POOL.enabled) return 0;
  const tiers = POOL.discountBps;
  return tiers[Math.min(others, tiers.length) - 1];
}
