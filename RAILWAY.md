# Railway deployment runbook — Kwema Ride Kenya

Everything needed to get Kwema Ride Kenya running on Railway, in order, with the
failure modes each step guards against.

---

## Services you need

Three services in one Railway project:

| Service | Source | Notes |
|---|---|---|
| `postgis` | **Template** → PostGIS | PostgreSQL 16 + PostGIS 3.4 |
| `redis` | **Database** → Redis | Geo index, locks, pub/sub |
| `kwema-ride-kenya-api` | **GitHub repo** | Builds from `Dockerfile` |

### The PostGIS requirement is not optional

Railway's standard PostgreSQL plugin uses the plain Debian Postgres image
with no extensions compiled in. This schema is built on `GEOGRAPHY(Point,
4326)` columns and GiST spatial indexes. On the default plugin, migration 001
fails immediately with:

```
error: type "geography" does not exist
```

Deploy the **PostGIS** template instead (`postgis/postgis`, PostgreSQL 16,
PostGIS 3.4). Same connection variables, same `DATABASE_URL` reference
syntax — only the image differs.

---

## Variables

On `kwema-ride-kenya-api` → **Variables** → **Raw Editor**:

```
DATABASE_URL=${{postgis.DATABASE_URL}}
REDIS_URL=${{Redis.REDIS_URL}}
DATABASE_SSL=true
NODE_ENV=production
COUNTRY=KE
PUBLIC_BASE_URL=https://<your-domain>
JWT_ACCESS_SECRET=<paste 48 random bytes>
OFFER_TOKEN_SECRET=<paste 48 different random bytes>
ADMIN_PHONE=+254XXXXXXXXX
```

The `${{postgis.DATABASE_URL}}` reference must match your PostGIS service's
actual name in the Railway sidebar. If you named it something else, change
the prefix or the reference resolves to nothing and the app exits with
`DATABASE_URL is not set`.

Generate the secrets:

```powershell
[Convert]::ToBase64String((1..48 | ForEach-Object { Get-Random -Max 256 }))
```

**Never set `PORT`.** Railway injects it. Overriding it means the app binds
one port while the healthcheck probes another, and every deploy fails
healthcheck and rolls back.

Add the mobile money and SMS credentials from `.env.example` once you have
sandbox keys. The app starts without them and logs a warning per missing
variable; collections for an unconfigured wallet return a provider error
until they are set.

---

## What happens on deploy

1. Railway reads `railway.json`, builds from `Dockerfile` (multi-stage, ends
   as a non-root Node alpine image).
2. Container starts: `node dist/db/migrate.js && node dist/main.js`.
3. `migrate.js` applies every numbered file in `db/`, recording each in
   `_migrations` with a checksum. Already-applied files are skipped.
4. Env validation runs. A missing or placeholder secret exits 1 here, before
   anything binds.
5. API listens on `0.0.0.0:$PORT`. Railway's healthcheck hits `/health`.

A failed migration exits non-zero, so Railway keeps the previous deployment
serving traffic rather than promoting a broken build.

---

## Verify

```bash
curl https://<service>.up.railway.app/health
# {"status":"ok","service":"kwema",...}

curl https://<service>.up.railway.app/api/health/ready
# {"status":"ready","checks":{"postgres":"ok","redis":"ok","postgis":"ok (3.4.x)"}}
```

If `postgis` reports `missing`, you're on the wrong database template.

Then confirm the seed landed:

```sql
SELECT category, base_fare_cents, per_km_cents, gazette_reference FROM tariffs;
SELECT code, name_en FROM service_zones;
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `type "geography" does not exist` | Default Postgres plugin | Redeploy on the PostGIS template |
| `DATABASE_URL is not set` | Service-name mismatch in the `${{...}}` reference | Match the reference to the sidebar name |
| `no pg_hba.conf entry ... no encryption` | `DATABASE_SSL=false` against an SSL-only server | Set `DATABASE_SSL=true` |
| `server does not support SSL` | `DATABASE_SSL=true` against a non-SSL server | Set `DATABASE_SSL=false` |
| Healthcheck fails, deploy rolls back | `PORT` set manually | Delete the `PORT` variable |
| `Refusing to start — N configuration problem(s)` | Missing/placeholder secret | Read the named variables in the log |
| Redis errors loop but app serves | Redis service not linked | Add the `REDIS_URL` reference |
| WebSocket connects then drops at 60s | Client not sending `hb` | Client must emit `hb` every 20s |
| Migration warns "has changed since applied" | An applied `.sql` file was edited | Add a new numbered migration instead |
| Operator callback returns 403 | `*_CALLBACK_TOKEN` differs from the one in the callback URL | Set the token once and let the server build the URL |

---

## After the first successful deploy

1. **Generate a public domain**: Settings → Networking → Generate Domain,
   then set `PUBLIC_BASE_URL` to it (no trailing slash). WebSockets work over
   it without extra configuration.
2. **Wallet callbacks.** The server builds its callback URLs from
   `PUBLIC_BASE_URL` and the per-operator `*_CALLBACK_TOKEN`:
   - M-Pesa: `<PUBLIC_BASE_URL>/api/payments/webhook/daraja?t=<MPESA_CALLBACK_TOKEN>` (plus `payout-result/daraja` and `payout-timeout/daraja` for B2C)
   - Airtel Money: `<PUBLIC_BASE_URL>/api/payments/webhook/airtel?t=<AIRTEL_CALLBACK_TOKEN>`
   Operators do not sign these, so the secret token in the URL is the first
   gate and the server's re-query of the operator is the second. Where the
   operator publishes IP ranges, restrict the routes to them as a backstop.
3. **Replace the seeded tariffs.** Every rate in `002_seed.sql` is marked
   `PLACEHOLDER`. Enter the official tariff figures in force and record the
   reference. Do this as a *new* migration file — never edit an applied one.
4. **Set `ADMIN_PHONE`** — no admin is seeded.
5. **Set `WS_ALLOWED_ORIGINS` and `CORS_ORIGINS`** once the admin panel has a
   domain. Until then they default open, which is fine for mobile clients but
   not something to leave in place.

## Scaling

Keep `numReplicas: 1` until you have real load. The architecture is
replica-safe — ride rooms go through the Socket.IO Redis adapter, offer locks
and driver responses live in Redis — but the breadcrumb buffer and WebSocket
throttle are per-node, so each replica adds a small independent flush batch
and its own rate-limit window. Neither is a correctness problem; both are
worth measuring before you scale out.
