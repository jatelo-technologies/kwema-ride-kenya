# Kwema Ride Kenya — platform architecture

A production architecture for a multi-tier ride-hailing service covering
bodabodas, bajajis, cars and XL/Express vehicles in Kenya. The same design serves Kwema Ride Kenya,
Uganda and Rwanda; what differs per country lives in `src/common/country.ts`
(phone format, currency, rounding, VAT, timezone, map bounds, wallets,
languages, emergency numbers) and in the seeded zones and tariffs.

---

## 1. Market assumptions this design makes

**Regulation moves, so no rate is a constant.** Ride-hailing is regulated in
Kenya by NTSA, confirm with the client. Guide fares, minimum fares and the share the
operator may take can change by notice. The engineering consequence is that
**no rate, cap or fee is a constant in this codebase**: all of them live in
the versioned `tariffs` table with a reference column, so a notice becomes a
new row and every historic fare stays reproducible under audit. The seeded
values are placeholders until the client supplies the figures in force.

**Cash is not a legacy payment method.** It remains a dominant rail,
especially for motorcycle and three-wheeler trips. The driver wallet,
cash-commission debt and the dispatch cut-off for drivers who owe too much are
core domain objects, not an afterthought.

**Mobile money is the digital default.** M-Pesa (Safaricom Daraja: STK push for collections, B2C for payouts) and Airtel Money. Each operator is
integrated directly behind one interface (`MobileMoneyProvider`), so adding or
replacing a wallet is one class.

**Connectivity is intermittent, not absent.** Drivers lose signal for minutes
at a time. Every write path from a device is idempotent and buffered locally.

---

## 2. Stack

| Layer | Choice | Why this over the alternative |
|---|---|---|
| Mobile | **Flutter** | One codebase, and the render-everything-yourself model gives consistent behaviour on the entry-level Android devices that dominate the driver fleet. |
| Backend | **NestJS (TypeScript)** | Structured DI and decorators keep the modules legible; the same language as the website and admin panel. |
| Database | **PostgreSQL 16 + PostGIS 3.4** | `GEOGRAPHY` types give true-metre `ST_DWithin`/`ST_Distance` with no projection juggling, and the KNN `<->` operator on a GiST index is a credible dispatch fallback. |
| Cache / geo | **Redis 7** | `GEOSEARCH` for the dispatch hot path, pub/sub for the Socket.IO adapter, distributed locks for offer reservation, payout results. |
| Realtime | **Socket.IO + Redis adapter** | Automatic reconnection with backoff and a polling fallback for proxies that still break WS upgrades. |
| Maps | **Google Maps** (primary), **Mapbox** (fallback) | Directions, geocoding and place search run server-side so no server key ships in an APK. |
| Website and admin | **Static pages served by the API** | One deployable unit per country; no separate front-end service to keep in step. |

---

## 3. Service topology

```
   Rider app ────────┐
   Driver app ───────┼──►  API service (NestJS)  ◄── operator callbacks
   Website / admin ──┘     auth · rides · dispatch · pricing · payments
                                  │
                      ┌───────────┴───────────┐
                      ▼                       ▼
             PostgreSQL + PostGIS     Redis (geo, pub/sub, locks)
```

The realtime gateway is stateless. Ride rooms live in the Redis adapter, so a
rolling deploy drops sockets that immediately reconnect and re-join from the
`session:ready` snapshot rather than losing trip state.

---

## 4. Ride lifecycle

```
rider taps request
        │
        ▼
 quote (locked, 180s TTL) ──► ride row created (idempotent on client id)
        │
        ▼
 dispatch: GEOSEARCH ring 1 → hard filters → score → shortlist (top 5)
        │
        ▼
 sequential offers, 15s each, driver locked in Redis for the offer window
        │                                   │
   accepted                             all declined / timeout
        │                                   │
        ▼                                   ▼
 driver en route ──► arrived ──► in_progress ──► completed
                                                     │
                                                     ▼
                                       settlement fare (capped at
                                       quote + 20% tolerance)
                                                     │
                                       ┌─────────────┴─────────────┐
                                    cash                    mobile money
                                       │                           │
                          driver wallet debited          collection request
                          by commission                  → callback → operator
                                                         re-query → settle
```

**Why sequential and not broadcast.** Broadcasting to all nearby drivers gets
the fastest acceptance and the worst driver experience: several drivers
accept, most lose, and acceptance-rate metrics become meaningless. Sequential
offers with a Redis `SET NX` lock per driver make double-offer impossible.

---

## 5. Fare model

```
base + (km × per_km) + (min × per_min) + waiting + zone surcharge
  → × surge (capped by tariff.max_surge_multiplier)
  → floor at minimum_fare
  → + booking fee (bps, capped)
  → − promo (funded by operator, not the driver)
  → round to the configured step (10 KES)
```

- **Surge is stepped, not continuous** (1.0 / 1.1 / 1.2 / 1.4 / 1.6). A smooth
  multiplier makes the displayed price flicker between taps, and a wide,
  fast-moving multiplier is a compliance risk under a regulated-fare regime.
- **Rounding to 10 KES** so a cash trip never needs awkward change.

Commission is charged on the transport fare only, excluding the booking fee
and any pass-through surcharge, and is capped at the tariff's
`commission_bps_cap`. VAT (16%; verify against the law in force) is computed
on the operator's service fee, not on the driver's transport service.

---

## 6. Security

**Authentication.** Phone + OTP is the primary flow. Access tokens are
short-lived JWTs carrying `sub`, `role`, `driverId` and a `jti`; refresh tokens
are opaque, rotated on use, and bound to a device fingerprint. Reuse of a
rotated refresh token revokes the whole family. The `jti` denylist in Redis is
checked on every WebSocket handshake so a logout or ban takes effect on live
sockets, not at the next token expiry.

**Authorisation.** Ride events are scoped to `ride:{id}` rooms a socket may
only join via a server-side membership check. A driver accepting a ride must
present the short-lived HMAC `offerToken` issued with the offer.

**Rate limiting.** Per-user and per-IP; per-socket in `WsThrottleGuard` for
location pings; a hard cap on payment initiation, because each attempt pushes
a prompt to a real handset.

**Mobile money callbacks.** Operators' callbacks are not signed in a way we can
rely on, so the design never trusts a callback body:

1. The callback URL carries a secret token (`?t=`), compared in constant time.
2. A callback only *triggers* a check: the service re-queries the operator
   (`confirmWithProvider`) and settles from that answer.
3. Settlement is idempotent on the external reference, runs under a row lock
   and checks the amount against the transaction we created.
4. A timeout or 5xx from an operator is an **unknown** outcome, never a failure.
   Only an explicit 4xx rejection marks a payment failed. Payouts are never
   retried automatically, so a slow operator cannot cause a double payment.
5. A reconciliation sweep re-queries anything still pending and settles it
   through the same path, crediting the driver wallet.

**Secrets.** Never on the device. The mobile apps hold no operator credentials,
no maps server key and no signing secret; every third-party call is
server-side.

**Fraud controls worth building early in this market:** GPS mock detection on
the driver app, trips whose driven distance diverges implausibly from the
routed distance, accounts sharing a device fingerprint, and cash trips
completed with no plausible movement.

---

## 7. Languages

The language chain is: the user's chosen language → the country default →
English. Server messages (SMS, push, payment narration) come from
`src/common/messages.ts`; the apps carry their own catalogue in
`mobile/lib/core/l10n/localization.dart`; the website has `public/i18n.js`.
Languages for this country: English, Swahili, default English.
Swahili is carried over from the earlier platform and still deserves a native-speaker check.

---

## 8. Low-bandwidth engineering

- Location pings use one-character keys and integer-scaled coordinates
  (×1e6).
- `perMessageDeflate` above a 256-byte threshold.
- Ping cadence adapts to movement: a stationary driver drops to a 30 m
  distance filter with a 45-second keepalive floor.
- The rider app renders a stale price at reduced opacity while re-quoting
  rather than showing a spinner in place of the number.
- Quotes are locked for 180 seconds, so a surge spike between tapping and
  confirming cannot raise the agreed price.
- The driver's offline buffer is bounded at 2,000 fixes and thins the oldest
  half by dropping alternate fixes, preserving route shape under long outages.

---

## 9. Where things are

| Path | What it is |
|---|---|
| `db/001_schema.sql` | Full PostGIS DDL, spatial indexes, nearby-driver function, zone resolution, partitioned breadcrumbs |
| `db/002_seed.sql` | Zones and **placeholder** tariffs for Kenya |
| `src/common/country.ts` | The country profile |
| `src/common/messages.ts` | Server-side message catalogue |
| `src/dispatch/dispatch.service.ts` | Expanding-ring GEOSEARCH, hard filters, scoring, locked sequential offers |
| `src/realtime/realtime.gateway.ts` | Socket.IO gateway: handshake auth, room rejoin, heartbeat, stale-socket reaping |
| `src/pricing/fare.service.ts` | Quote, settlement with tolerance cap, cancellation fees, surge, tariff resolution |
| `src/payments/mobile-money.providers.ts` | MpesaProvider (Safaricom Daraja); AirtelMoneyProvider (Airtel Africa Open API) |
| `src/payments/payments.service.ts` | Collection, callback handling, settlement, reconciliation |
| `mobile/lib/core/country_config.dart` | Phone format, currency, wallets, emergency number, map centre |
| `mobile/lib/core/l10n/localization.dart` | App translations |
| `mobile/lib/core/location/offline_location_queue.dart` | SQLite-buffered, ack-driven location pipeline |

---

## 10. What needs external confirmation rather than code

The tariff and commission rules in force, the operators' sandbox contracts
(the adapters were written from published API shapes and tested only against
mock servers), the emergency numbers, the licence requirements, and native
review of any translation not marked complete.
