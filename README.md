# Kora

Kora is a TypeScript-first, Redis-inspired key-value service for modern applications. It combines an always-on in-memory data engine, TTL expiration, authenticated HTTP commands, append-only persistence, snapshots, and an npm generator that creates a Vercel gateway plus a Railway deployment target inside any codebase.

Kora is designed for backend-only caching, short-lived sessions, counters, rate-limit primitives, and temporary application state. It is not a drop-in replacement for Redis yet: version `0.1.0` exposes a secure HTTP API rather than Redis TCP/RESP compatibility.

## Why Kora uses two deployment targets

Vercel is a good host for application routes, but serverless functions do not provide one permanent shared in-memory process. Kora therefore keeps the stateful engine on Railway and deploys a small authenticated gateway to Vercel.

```text
Application backend on Vercel
             |
             | HTTPS with KORA_GATEWAY_TOKEN
             v
Kora gateway on Vercel
             |
             | HTTPS with KORA_UPSTREAM_TOKEN
             v
Kora engine on Railway
             |
             v
RAM + Railway persistent volume
```

The browser never receives a Kora token. Application server code calls Kora through the Vercel gateway.

## Current features

- TypeScript and Node.js 22 runtime
- JSON key-value storage held in memory
- Per-key TTL expiration
- Atomic serial writes and counters
- Authenticated HTTP API using Bearer tokens
- Append-only file recovery after restarts
- Snapshot creation and periodic snapshots
- Typed `KoraClient` for application backends
- `kora init` scaffold generator
- Railway engine template with persistent-volume configuration
- Vercel gateway template with separate gateway and engine secrets

## Install and generate a deployment

After the package is published to npm:

```bash
npx @sanketpadhyal/kora@latest init
```

This creates a new `kora/` directory in the current codebase:

```text
kora/
├── railway/
│   ├── Dockerfile
│   ├── railway.toml
│   ├── package.json
│   └── .env.example
├── vercel/
│   ├── api/kora/[...path].js
│   ├── vercel.json
│   ├── package.json
│   └── .env.example
└── README.md
```

The generated `kora/README.md` contains the exact Railway and Vercel deployment instructions.

## Application usage

Install Kora in server-side application code:

```bash
npm install @sanketpadhyal/kora
```

Set private environment variables:

```text
KORA_URL=https://your-kora-gateway.vercel.app
KORA_TOKEN=your-kora-gateway-token
```

Use the typed client in a backend route, server action, worker, or API service:

```ts
import { KoraClient } from "@sanketpadhyal/kora";

const kora = new KoraClient({
  url: process.env.KORA_URL!,
  token: process.env.KORA_TOKEN!
});

await kora.set("session:user-42", { role: "member" }, { ttlSeconds: 3600 });

const session = await kora.get<{ role: string }>("session:user-42");

await kora.increment("metrics:page-views");
```

## HTTP API

All routes other than `/health` require `Authorization: Bearer <token>`.

| Method | Route | Request body | Result |
| --- | --- | --- | --- |
| `GET` | `/v1/keys/:key` | None | Stored value and expiry |
| `PUT` | `/v1/keys/:key` | `{ value, ttlSeconds? }` | Stored value and expiry |
| `DELETE` | `/v1/keys/:key` | None | Deletion status |
| `POST` | `/v1/keys/:key/incr` | `{ delta? }` | New numeric value |
| `GET` | `/v1/stats` | None | Key counts and uptime |
| `POST` | `/v1/snapshot` | None | Starts a durable snapshot |

When using the Vercel gateway, prefix routes with `/api/kora`.

## Local development

```bash
npm install
npm test
KORA_TOKEN=replace-with-a-32-character-or-longer-secret npm run build
KORA_TOKEN=replace-with-a-32-character-or-longer-secret node dist/cli.js start
```

In another terminal:

```bash
curl -X PUT http://localhost:8080/v1/keys/demo \
  -H "Authorization: Bearer replace-with-a-32-character-or-longer-secret" \
  -H "Content-Type: application/json" \
  -d '{"value":{"message":"Hello from Kora"},"ttlSeconds":60}'
```

## Publish to npm

The package name is currently scoped as `@sanketpadhyal/kora`. Before publishing, ensure that scope belongs to the npm account used for publishing.

```bash
npm login
npm test
npm publish
```

`publishConfig.access` is already set to `public`.

## Roadmap

- Hashes, lists, sets, and sorted sets
- Active expiry with a min-heap scheduler
- AOF compaction
- Memory limits and LRU/LFU eviction
- Pub/sub and durable queues
- Metrics endpoint for Prometheus
- RESP protocol and Redis-client compatibility
- Replication and failover

## Security

Use separate secrets for the Railway engine and Vercel gateway. Keep all Kora tokens in server-side environment variables. Do not expose the Railway engine token or a Vercel gateway token to browsers, mobile clients, or public repositories.

## License

Apache-2.0
