# Kora

Kora is a TypeScript-first, Redis-inspired key-value service for modern applications. It combines an always-on in-memory data engine, TTL expiration, authenticated HTTP commands, append-only persistence, snapshots, and an npm generator that creates a Railway deployment target inside any codebase.

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
- Per-key TTL expiration
- Atomic serial writes and counters
- Authenticated HTTP API using Bearer tokens
- Append-only file recovery after restarts
- Snapshot creation and periodic snapshots
- Typed `KoraClient` for application backends
- `kora init` Railway deployment generator
- Railway engine template with persistent-volume configuration

## Install and generate a deployment

After the package is published to npm:

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
| `GET` | `/v1/stats` | None | Key counts and uptime |
| `POST` | `/v1/snapshot` | None | Starts a durable snapshot |

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

Keep Kora tokens in server-side environment variables. Do not expose the Kora token to browsers, mobile clients, or public repositories.

## License

Apache-2.0
