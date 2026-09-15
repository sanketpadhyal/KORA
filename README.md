# Kora

Kora is a TypeScript-first, Redis-inspired key-value service for modern applications. It combines an always-on in-memory data engine, active TTL expiration, authenticated HTTP commands, fsync-backed append-only persistence, snapshots, compaction, memory limits, and an npm generator that creates a Railway deployment target inside any codebase.

Kora is designed for backend-only caching, short-lived sessions, counters, rate-limit primitives, and temporary application state. It is not a drop-in replacement for Redis yet: version `0.1.0` exposes a secure HTTP API rather than Redis TCP/RESP compatibility.

## Railway-first architecture

Kora runs as one always-on Railway service with a persistent volume. Application backend code connects directly to its HTTPS API using a secret Bearer token.

```text
Application backend
       |
       | HTTPS with KORA_TOKEN
       v
Kora engine on Railway
       |
       v
RAM + Railway persistent volume
```

The browser never receives a Kora token.

## Current features

- TypeScript and Node.js 22 runtime
- JSON key-value storage held in memory
- Lazy and active per-key TTL expiration
- Atomic serial writes and counters
- Authenticated HTTP API using Bearer tokens
- Fsync-backed append-only file recovery after restarts
- Atomic snapshots and scheduled AOF compaction
- LRU eviction or strict no-eviction memory limits
- Atomic expiry changes and TTL inspection
- Atomic fixed-window rate-limit primitive
- Authenticated Prometheus-compatible metrics
- Typed `KoraClient` for application backends
- `kora init` Railway deployment generator
- Railway engine template with persistent-volume configuration

## Install and generate a deployment

Use Kora from GitHub today:

```bash
npm install @sanketpadhyal/kora@github:sanketpadhyal/KORA#main
npx kora init kora-engine --package-source github:sanketpadhyal/KORA#main
```

After the package is published to npm, the shorter workflow is:

```bash
npx @sanketpadhyal/kora@latest init
```

This creates a new `kora/` directory in the current codebase:

```text
kora/
├── Dockerfile
├── railway.toml
├── package.json
├── .env.example
└── README.md
```

The generated `kora/README.md` contains the Railway deployment instructions.

## Application usage

Install Kora in server-side application code:

```bash
npm install @sanketpadhyal/kora
```

Until the first npm release, use this equivalent command instead:

```bash
npm install @sanketpadhyal/kora@github:sanketpadhyal/KORA#main
```

Set private environment variables:

```text
KORA_URL=https://your-kora-engine.up.railway.app
KORA_TOKEN=your-kora-engine-token
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
| `GET` | `/v1/keys/:key/ttl` | None | Remaining TTL in seconds (`-1` persistent, `-2` missing) |
| `POST` | `/v1/keys/:key/expire` | `{ ttlSeconds }` | Set an expiry on an existing key |
| `POST` | `/v1/rate-limits/:key` | `{ limit, windowSeconds }` | Atomically consume a fixed-window rate-limit slot |
| `GET` | `/v1/stats` | None | Key counts and uptime |
| `GET` | `/metrics` | None | Prometheus text metrics |
| `POST` | `/v1/snapshot` | None | Creates an atomic snapshot |
| `POST` | `/v1/compact` | None | Snapshots then resets the append-only log |

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `KORA_TOKEN` | Required | A 24-character-or-longer secret for all non-health routes |
| `PORT` | `8080` | HTTP listen port; Railway provides this automatically |
| `KORA_DATA_DIR` | `.kora-data` | Persistent location for `appendonly.aof` and `snapshot.json` |
| `KORA_MAX_MEMORY_MB` | Unlimited | Approximate upper bound for stored key/value memory |
| `KORA_EVICTION_POLICY` | `lru` | `lru` evicts least-recently-used values; `noeviction` rejects new writes |
| `KORA_EXPIRATION_INTERVAL_MS` | `1000` | Active-expiration scan interval |
| `KORA_SNAPSHOT_INTERVAL_MS` | `300000` | Snapshot interval |
| `KORA_COMPACTION_INTERVAL_MS` | `3600000` | AOF compaction interval |

Attach a Railway volume at `/data` and set `KORA_DATA_DIR=/data`. Without a persistent volume, data will disappear on redeploy or restart.

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

## Scope and roadmap

Kora is a durable single-node HTTP key-value service. It is not Redis protocol compatible yet, and it does not claim replication, clustering, multi-node failover, or Redis-module compatibility.

- Hashes, lists, sets, and sorted sets
- Pub/sub and durable queues
- RESP protocol and Redis-client compatibility
- Replication and failover

## Security

Keep Kora tokens in server-side environment variables. Do not expose the Kora token to browsers, mobile clients, or public repositories.

## License

Apache-2.0
