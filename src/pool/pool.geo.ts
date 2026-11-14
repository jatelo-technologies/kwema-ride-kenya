/**
 * Pure geometry for pool matching. No database, no Redis, no clock, so every
 * rule can be unit-tested with plain coordinates.
 *
 * Distances use a local flat-earth projection (equirectangular) around the
 * segment being tested. Over the few kilometres a pooled city trip spans the
 * error is well under a percent, which is far inside the tolerances used
 * (hundreds of metres), and it keeps cross-track and along-track maths simple.
 */

import { POOL } from './pool.config';

export interface Pt {
  lat: number;
  lng: number;
}

const R = 6_371_000;
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

export function haversineM(a: Pt, b: Pt): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial compass bearing a -> b, degrees 0..360. */
export function bearingDeg(a: Pt, b: Pt): number {
  const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
  const x =
    Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) -
    Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

/** Smallest angle between two bearings, 0..180. */
export function bearingDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * Position of `p` relative to the segment s -> e.
 *  crossM  shortest distance from p to the segment (clamped to its ends)
 *  t       how far along the segment p projects: 0 at s, 1 at e, <0 behind s,
 *          >1 beyond e (unclamped, so "behind the vehicle" is detectable)
 */
export function relativeToSegment(s: Pt, e: Pt, p: Pt): { crossM: number; t: number } {
  const lat0 = rad((s.lat + e.lat) / 2);
  const kx = R * Math.cos(lat0);
  const ky = R;
  const ex = rad(e.lng - s.lng) * kx;
  const ey = rad(e.lat - s.lat) * ky;
  const px = rad(p.lng - s.lng) * kx;
  const py = rad(p.lat - s.lat) * ky;
  const len2 = ex * ex + ey * ey;
  if (len2 < 1) {
    return { crossM: Math.hypot(px, py), t: 0 };
  }
  const t = (px * ex + py * ey) / len2;
  const tc = Math.min(1, Math.max(0, t));
  return { crossM: Math.hypot(px - tc * ex, py - tc * ey), t };
}

export interface RouteRef {
  /** Where the shared vehicle is now (or the host's pickup if it has no driver yet). */
  from: Pt;
  /** The farthest drop-off still to come. */
  to: Pt;
  /** True when `from` is a live vehicle position rather than a pickup point. */
  vehicleMoving: boolean;
}

export interface Joiner {
  pickup: Pt;
  dropoff: Pt;
}

export interface MatchVerdict {
  ok: boolean;
  /** Why not, for logs and tests. */
  reason?: string;
  /** Extra metres the vehicle drives to take this rider, if ok. */
  detourM: number;
  /** Straight-line metres from the vehicle to the new pickup. */
  toPickupM: number;
}

/**
 * Can this rider ride along with this trip?
 *
 * Rules, all of which must hold:
 *  1. Same direction of travel, within POOL.bearingMaxDeg.
 *  2. Pickup is close to the route, and not already behind the vehicle.
 *  3. Drop-off is close to the route and comes after the pickup.
 *  4. Taking this rider adds a bounded detour for the driver.
 */
export function evaluateMatch(route: RouteRef, j: Joiner): MatchVerdict {
  const fail = (reason: string, detourM = 0, toPickupM = 0): MatchVerdict =>
    ({ ok: false, reason, detourM, toPickupM });

  const routeLen = haversineM(route.from, route.to);
  const toPickupM = haversineM(route.from, j.pickup);
  const jLen = haversineM(j.pickup, j.dropoff);

  if (jLen < 300) return fail('trip_too_short', 0, toPickupM);
  if (routeLen < 300) return fail('route_too_short', 0, toPickupM);

  const dirDiff = bearingDiff(bearingDeg(route.from, route.to), bearingDeg(j.pickup, j.dropoff));
  if (dirDiff > POOL.bearingMaxDeg) return fail('different_direction', 0, toPickupM);

  const pu = relativeToSegment(route.from, route.to, j.pickup);
  const dr = relativeToSegment(route.from, route.to, j.dropoff);

  if (pu.crossM > POOL.pickupMaxM) return fail('pickup_off_route', 0, toPickupM);
  if (dr.crossM > POOL.dropoffMaxM) return fail('dropoff_off_route', 0, toPickupM);

  // A moving vehicle cannot turn round for someone it has already passed.
  if (route.vehicleMoving) {
    if (toPickupM > POOL.driverToPickupMaxM) return fail('pickup_too_far', 0, toPickupM);
    if (pu.t < 0 && toPickupM > 600) return fail('pickup_behind', 0, toPickupM);
  }

  // The new rider must be going forward along the route, not back along it.
  if (dr.t <= pu.t) return fail('dropoff_before_pickup', 0, toPickupM);

  const detourM = Math.max(
    0,
    toPickupM + jLen + haversineM(j.dropoff, route.to) - routeLen,
  );
  const allowed = Math.max(POOL.detourMaxM, (routeLen * POOL.detourMaxBps) / 10_000);
  if (route.vehicleMoving && detourM > allowed) return fail('detour_too_large', detourM, toPickupM);

  return { ok: true, detourM: Math.round(detourM), toPickupM: Math.round(toPickupM) };
}
