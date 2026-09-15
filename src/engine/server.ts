import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { KoraStore } from "./store.js";

export type KoraServerOptions = {
  dataDir: string;
  token: string;
  port: number;
  host?: string;
  snapshotIntervalMs?: number;
};

type JsonObject = Record<string, unknown>;

export async function startKoraServer(options: KoraServerOptions): Promise<{ server: Server; store: KoraStore; close: () => Promise<void> }> {
  if (!options.token || options.token.length < 24) {
    throw new Error("KORA_TOKEN must contain at least 24 characters");
  }
  const store = new KoraStore(options.dataDir);
  await store.open();
  const server = createServer((request, response) => {
    void handleRequest(request, response, store, options.token);
  });
  const interval = options.snapshotIntervalMs && options.snapshotIntervalMs > 0
    ? setInterval(() => {
        void store.snapshot();
      }, options.snapshotIntervalMs)
    : undefined;
  interval?.unref();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host ?? "0.0.0.0", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    server,
    store,
    close: async () => {
      if (interval) {
        clearInterval(interval);
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      await store.close();
    }
  };
}

async function handleRequest(request: IncomingMessage, response: ServerResponse, store: KoraStore, token: string): Promise<void> {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, { status: "ok" });
      return;
    }
    if (!isAuthorized(request, token)) {
      sendJson(response, 401, { error: "unauthorized" });
      return;
    }
    const parts = url.pathname.split("/").filter(Boolean);
    if (request.method === "GET" && url.pathname === "/v1/stats") {
      sendJson(response, 200, store.stats());
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/snapshot") {
      await store.snapshot();
      sendJson(response, 202, { status: "snapshot-created" });
      return;
    }
    if (parts.length === 3 && parts[0] === "v1" && parts[1] === "keys") {
      const key = decodeURIComponent(parts[2]);
      if (request.method === "GET") {
        const entry = await store.get(key);
        if (!entry) {
          sendJson(response, 404, { error: "key not found" });
          return;
        }
        sendJson(response, 200, entry);
        return;
      }
      if (request.method === "PUT") {
        const body = await readJson(request);
        if (!("value" in body)) {
          sendJson(response, 400, { error: "value is required" });
          return;
        }
        const ttlSeconds = body.ttlSeconds;
        if (ttlSeconds !== undefined && (typeof ttlSeconds !== "number" || !Number.isFinite(ttlSeconds))) {
          sendJson(response, 400, { error: "ttlSeconds must be a finite number" });
          return;
        }
        const entry = await store.set(key, body.value, ttlSeconds as number | undefined);
        sendJson(response, 200, entry);
        return;
      }
      if (request.method === "DELETE") {
        const deleted = await store.delete(key);
        sendJson(response, deleted ? 200 : 404, { deleted });
        return;
      }
    }
    if (parts.length === 4 && parts[0] === "v1" && parts[1] === "keys" && parts[3] === "incr" && request.method === "POST") {
      const body = await readJson(request);
      const delta = body.delta === undefined ? 1 : body.delta;
      if (typeof delta !== "number" || !Number.isFinite(delta)) {
        sendJson(response, 400, { error: "delta must be a finite number" });
        return;
      }
      const value = await store.increment(decodeURIComponent(parts[2]), delta);
      sendJson(response, 200, { value });
      return;
    }
    sendJson(response, 404, { error: "route not found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "internal server error";
    const status = message.includes("must") || message.includes("cannot") || message.includes("not a finite") || message.includes("JSON") ? 400 : 500;
    sendJson(response, status, { error: message });
  }
}

function isAuthorized(request: IncomingMessage, token: string): boolean {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) {
    return false;
  }
  const candidate = Buffer.from(authorization.slice(7));
  const expected = Buffer.from(token);
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

async function readJson(request: IncomingMessage): Promise<JsonObject> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_048_576) {
      throw new Error("request body exceeds 1 MB");
    }
    chunks.push(buffer);
  }
  const source = Buffer.concat(chunks).toString("utf8");
  if (!source) {
    return {};
  }
  const parsed = JSON.parse(source) as unknown;
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("request body must be a JSON object");
  }
  return parsed as JsonObject;
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(payload));
}
