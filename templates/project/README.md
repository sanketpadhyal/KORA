# Kora deployment

This directory was created by `kora init`. It contains a Railway deployment for the Kora data engine, including in-memory storage, append-only persistence, and snapshots.

## Deploy Kora to Railway

```bash
cd kora
npm install
railway init
railway up
```

In Railway, attach a persistent volume at `/data`, then set these variables:

```text
KORA_TOKEN=replace-with-a-32-character-or-longer-secret
KORA_DATA_DIR=/data
KORA_SNAPSHOT_INTERVAL_MS=300000
KORA_COMPACTION_INTERVAL_MS=3600000
KORA_EXPIRATION_INTERVAL_MS=1000
KORA_MAX_MEMORY_MB=128
KORA_EVICTION_POLICY=lru
```

After deployment, copy the Railway public domain, for example `https://kora-engine-production.up.railway.app`. This is the Kora URL used by the application's backend.

## Connect an application backend

Install the Kora package in the application's backend:

```bash
npm install {{PACKAGE_NAME}}
```

Set backend-only environment variables:

```text
KORA_URL=https://kora-engine-production.up.railway.app
KORA_TOKEN=the-value-of-KORA_TOKEN-on-Railway
```

Use it in server-side code:

```ts
import { KoraClient } from "{{PACKAGE_NAME}}";

const kora = new KoraClient({
  url: process.env.KORA_URL!,
  token: process.env.KORA_TOKEN!
});

await kora.set("session:user-42", { role: "member" }, { ttlSeconds: 3600 });
const session = await kora.get("session:user-42");
```

Do not expose `KORA_TOKEN` in browser code.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/keys/:key` | Retrieve a value |
| `PUT` | `/v1/keys/:key` | Store `{ value, ttlSeconds? }` |
| `DELETE` | `/v1/keys/:key` | Delete a value |
| `POST` | `/v1/keys/:key/incr` | Increment `{ delta? }` |
| `GET` | `/v1/keys/:key/ttl` | Read remaining TTL |
| `POST` | `/v1/keys/:key/expire` | Set `{ ttlSeconds }` on an existing key |
| `POST` | `/v1/rate-limits/:key` | Consume `{ limit, windowSeconds }` atomically |
| `GET` | `/v1/stats` | Inspect key and expiry counts |
| `GET` | `/metrics` | Prometheus-compatible metrics |
| `POST` | `/v1/snapshot` | Create an atomic snapshot |
| `POST` | `/v1/compact` | Snapshot and compact the append-only log |

## Local test

```bash
npm install
KORA_TOKEN=replace-with-a-32-character-or-longer-secret npm run start
```

In another terminal:

```bash
curl -X PUT http://localhost:8080/v1/keys/demo \
  -H "Authorization: Bearer replace-with-a-32-character-or-longer-secret" \
  -H "Content-Type: application/json" \
  -d '{"value":{"hello":"Kora"},"ttlSeconds":60}'
```
