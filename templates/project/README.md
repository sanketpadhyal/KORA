# Kora deployment

This directory was created by `kora init`. It contains two deployment targets.

| Directory | Role | Host |
| --- | --- | --- |
| `railway/` | Kora data engine with RAM, append-only persistence, and snapshots | Railway |
| `vercel/` | Authenticated HTTPS gateway that forwards backend requests to the Kora engine | Vercel |

Kora uses Railway for the stateful engine because Vercel Functions do not provide a single permanent shared memory process. Deploy the Vercel gateway with the rest of an application's backend, and keep all Kora tokens server-side.

## 1. Deploy the Kora engine to Railway

```bash
cd kora/railway
npm install
railway init
railway up
```

In Railway, attach a persistent volume at `/data`, then set these variables:

```text
KORA_TOKEN=replace-with-a-32-character-or-longer-secret
KORA_DATA_DIR=/data
KORA_SNAPSHOT_INTERVAL_MS=300000
```

After deployment, copy the Railway public domain, for example `https://kora-engine-production.up.railway.app`.

## 2. Deploy the gateway to Vercel

```bash
cd ../vercel
npx vercel
```

Set these Vercel environment variables before the production deployment:

```text
KORA_UPSTREAM_URL=https://kora-engine-production.up.railway.app
KORA_UPSTREAM_TOKEN=the-same-value-as-KORA_TOKEN-on-Railway
KORA_GATEWAY_TOKEN=a-different-32-character-or-longer-secret
```

Deploy the gateway:

```bash
npx vercel --prod
```

Copy the Vercel deployment URL. This is the Kora URL used by the application's backend.

## 3. Connect an application backend

Install the Kora package in the application's backend:

```bash
npm install {{PACKAGE_NAME}}
```

Set backend-only environment variables:

```text
KORA_URL=https://your-kora-gateway.vercel.app
KORA_TOKEN=the-value-of-KORA_GATEWAY_TOKEN
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

Do not expose `KORA_TOKEN`, `KORA_GATEWAY_TOKEN`, or `KORA_UPSTREAM_TOKEN` in browser code.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/kora/v1/keys/:key` | Retrieve a value |
| `PUT` | `/api/kora/v1/keys/:key` | Store `{ value, ttlSeconds? }` |
| `DELETE` | `/api/kora/v1/keys/:key` | Delete a value |
| `POST` | `/api/kora/v1/keys/:key/incr` | Increment `{ delta? }` |
| `GET` | `/api/kora/v1/stats` | Inspect key and expiry counts |

## Local test

```bash
cd railway
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
