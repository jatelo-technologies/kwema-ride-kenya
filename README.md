# Kwema Ride Kenya

Ride-hailing, parcel and food delivery for Kenya: bodabodas, bajajis, cars and XL/Express vehicles,
with mobile money, card and cash payments, apps in English and Swahili, and a firm
price before every trip.

Backend: NestJS + PostgreSQL/PostGIS + Redis + Socket.IO.
Mobile: Flutter (rider and driver apps, Android and iPhone).
Website and admin panel: served by the same API service from `public/`.

Built by Jatelo Technologies. See [ARCHITECTURE.md](./ARCHITECTURE.md) for the
design reasoning and [RAILWAY.md](./RAILWAY.md) for the deployment runbook.

---

## One deployment, one country

This folder is the **Kenya** product. It is generated from the same
codebase as the sibling Kwema Ride products for the other East African
countries, but it is self-contained: its
own database, its own merchant accounts, its own domain, its own repository.
Nothing here talks to another country's deployment.

`COUNTRY=KE` (already the built-in default) selects the profile in
`src/common/country.ts`: +254 phone numbers (9 digits after the code), KES currency rounded
to 10 KES, Africa/Nairobi timezone, map bounds, emergency numbers, VAT 16%, driver wallet
limits.

Money is stored as integer "cents" (1 KES = 100 cents) even though
KES is shown without a subunit; display code divides by 100.

The migrations in `db/` were generated for a **fresh Kwema Ride Kenya database**
(phone constraints, timezone, zones and placeholder tariffs). Do not run them
against a database that already holds another country's data.

## What is included

| Area | Status |
|---|---|
| Rides, dispatch, pricing, ratings, SOS, profile photos | Included and tested end to end against a local database |
| Parcel and food courier | Included |
| Electric vehicle tiers | Included |
| M-Pesa and Airtel Money | Adapters written from the operators' published API shapes and **tested only against mock servers**. Reconcile with each operator's sandbox before taking real money |
| Card payments | DPO adapter included; unverified against a live DPO account |
| Driver payouts | Admin records a payout, then sends it to the wallet from the panel. A timeout or 5xx is never treated as a failure and payouts are never retried automatically |
| In-ride messaging, call, copy number | Included. In-app *voice* calling needs a calling provider account (not included) |
| Push notifications | Backend + apps ready; inert until Firebase values are set |
| Legal pages | `/privacy`, `/terms` (EN / SW) — **drafts for counsel to review** |
| iPhone apps | Workflow `ios-build.yml` builds unsigned apps; signing and App Store need the client's Apple Developer account |

## What the client must supply

1. M-Pesa and Airtel Money merchant accounts and the integration credentials the operators issue.
2. A card acquirer (or DPO account) and its credentials.
3. A Firebase project (push) and an Apple Developer account (iPhone).
4. A Google Maps account (server key, browser key, Android and iOS keys).
5. An SMS gateway account for OTP codes.
6. **Written confirmation** of the emergency numbers (999 / 112 are
   unverified), the official tariff and the NTSA, confirm with the client licence requirements.
7. A native-speaker check of the Swahili text in the apps, website and SMS.
8. Legal review of `/privacy` and `/terms`, and the company name, address,
   and governing-law details they leave in brackets.
9. The real domain (the code uses `kwemaride.co.ke` as a placeholder) and logo
   approval.

## Deploy to Railway

1. Push this folder to **its own** GitHub repository (not another country's
   and never the original Kwema one).
2. Railway → New Project → Deploy from GitHub → pick the repo. `railway.json`
   builds from the `Dockerfile`.
3. Add the **PostGIS** template (not the default Postgres plugin: migration
   001 needs `GEOGRAPHY`), then a Redis database.
4. Set variables from `.env.example` (at minimum `DATABASE_URL`, `REDIS_URL`,
   `DATABASE_SSL=true`, `JWT_ACCESS_SECRET`, `OFFER_TOKEN_SECRET`,
   `PUBLIC_BASE_URL`, `ADMIN_PHONE`). Do not set `PORT`.
5. Deploy. Migrations run before the server binds.
6. Verify: `/health`, `/api/health/ready`, `/status`.
7. Operator callbacks are built by the server from `PUBLIC_BASE_URL` and each
   operator's `*_CALLBACK_TOKEN`; see `.env.example`. Callbacks are **never
   trusted on their own**: the server re-queries the operator before it
   marks anything paid.

## Apps

Android builds run in GitHub Actions (`mobile-release.yml`, tag `v*` or run it
by hand). Repository secrets/variables: `ANDROID_MAPS_API_KEY`, optional
`FIREBASE_API_KEY`, `FIREBASE_ANDROID_APP_ID_RIDER`,
`FIREBASE_ANDROID_APP_ID_DRIVER`, `FIREBASE_MESSAGING_SENDER_ID`,
`FIREBASE_PROJECT_ID`, and the `API_BASE_URL` variable. iPhone: see
`ios-build.yml`. The apps use the application ids `com.jatelo.kwema.ke.rider` and
`com.jatelo.kwema.ke.driver`.

**The Flutter code has not been compiled** (the build environment had no
Flutter SDK). The first CI run is the real test; send the analyzer output
back and it gets fixed.

## Local development

```bash
docker compose up --build   # PostGIS, Redis, API on :3000
npm install && npm run start:dev
npx tsc --noEmit            # typecheck
```

Without `SMS_API_URL`, OTP codes print to the API log.

## Before you go live

1. Replace the placeholder tariffs (`db/002_seed.sql`, rows marked
   `PLACEHOLDER`) with the official rates, and record the reference.
2. Replace the rough city and airport polygons with real operating
   boundaries.
3. Reconcile the operator adapters with their sandboxes before taking real
   money; run a payout end to end in sandbox.
4. Confirm the emergency numbers and update `src/common/country.ts` and
   `kEmergencyNumber` in `mobile/lib/core/country_config.dart`.

5. Set `ADMIN_PHONE`, sign in once, and check the admin panel.
6. Rotate every secret that was ever shared in a chat or a screenshot.
