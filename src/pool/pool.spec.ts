import { evaluateMatch, bearingDeg, bearingDiff, haversineM, relativeToSegment } from './pool.geo';
import { discountBpsFor, poolSeatsFor, isPoolCategory } from './pool.config';

// A commute in Nairobi: Kasarani -> the CBD, heading south-west.
const KASARANI = { lat: -1.2218, lng: 36.8985 };
const CBD = { lat: -1.2833, lng: 36.8219 };

describe('geometry', () => {
  it('measures distance and bearing sensibly', () => {
    const d = haversineM(KASARANI, CBD);
    expect(d).toBeGreaterThan(10_000);
    expect(d).toBeLessThan(13_000);
    const b = bearingDeg(KASARANI, CBD);
    expect(b).toBeGreaterThan(200);
    expect(b).toBeLessThan(235);
    expect(bearingDiff(350, 10)).toBe(20);
    expect(bearingDiff(10, 350)).toBe(20);
  });

  it('projects a point onto a segment', () => {
    const mid = { lat: (KASARANI.lat + CBD.lat) / 2, lng: (KASARANI.lng + CBD.lng) / 2 };
    const r = relativeToSegment(KASARANI, CBD, mid);
    expect(r.crossM).toBeLessThan(5);
    expect(r.t).toBeGreaterThan(0.49);
    expect(r.t).toBeLessThan(0.51);
  });
});

describe('evaluateMatch', () => {
  // The vehicle is a third of the way in, still heading for the CBD.
  const frac = (t: number) => ({
    lat: KASARANI.lat + (CBD.lat - KASARANI.lat) * t,
    lng: KASARANI.lng + (CBD.lng - KASARANI.lng) * t,
  });
  const moving = { from: frac(0.3), to: CBD, vehicleMoving: true };

  it('accepts a rider ahead on the route going the same way', () => {
    const v = evaluateMatch(moving, { pickup: frac(0.45), dropoff: frac(0.9) });
    expect(v.ok).toBe(true);
    expect(v.detourM).toBeLessThan(500);
  });

  it('rejects a rider going the opposite way', () => {
    const v = evaluateMatch(moving, { pickup: frac(0.9), dropoff: frac(0.45) });
    expect(v.ok).toBe(false);
  });

  it('rejects a pickup the vehicle has already passed', () => {
    const v = evaluateMatch(moving, { pickup: frac(0.05), dropoff: frac(0.8) });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/behind|too_far|off_route/);
  });

  it('rejects a pickup far off the route', () => {
    const off = { lat: frac(0.45).lat + 0.04, lng: frac(0.45).lng + 0.04 };
    const v = evaluateMatch(moving, { pickup: off, dropoff: frac(0.9) });
    expect(v.ok).toBe(false);
  });

  it('rejects a trip heading somewhere else', () => {
    const elsewhere = { lat: frac(0.45).lat, lng: frac(0.45).lng + 0.12 };
    const v = evaluateMatch(moving, { pickup: frac(0.45), dropoff: elsewhere });
    expect(v.ok).toBe(false);
  });

  it('allows joining a trip that has no driver yet when both ends are close', () => {
    const waiting = { from: KASARANI, to: CBD, vehicleMoving: false };
    const v = evaluateMatch(waiting, { pickup: frac(0.02), dropoff: frac(0.95) });
    expect(v.ok).toBe(true);
  });

  it('refuses trivially short hops', () => {
    const v = evaluateMatch(moving, { pickup: frac(0.45), dropoff: frac(0.4501) });
    expect(v.ok).toBe(false);
  });
});

describe('pool config', () => {
  it('has no discount alone and deeper tiers with more riders', () => {
    expect(discountBpsFor(0)).toBe(0);
    expect(discountBpsFor(1)).toBe(2500);
    expect(discountBpsFor(2)).toBe(3500);
    expect(discountBpsFor(3)).toBe(4000);
    expect(discountBpsFor(9)).toBe(4000);
  });

  it('pools cars and tuk-tuks but not motorbikes', () => {
    expect(isPoolCategory('standard')).toBe(true);
    expect(isPoolCategory('xl')).toBe(true);
    expect(isPoolCategory('bajaji')).toBe(true);
    expect(isPoolCategory('boda')).toBe(false);
    expect(isPoolCategory('e_boda')).toBe(false);
    expect(isPoolCategory('express')).toBe(false);
    expect(poolSeatsFor('standard')).toBe(3);
  });
});
