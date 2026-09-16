import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { KoraClient } from "../dist/index.js";
import { startKoraServer } from "../dist/engine/server.js";

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const enginePort = Number(process.env.DEMO_KORA_PORT ?? "8081");
const appPort = Number(process.env.DEMO_PORT ?? "3000");
const koraToken = process.env.DEMO_KORA_TOKEN ?? "demo-kora-token-that-is-at-least-24-characters";
const engine = await startKoraServer({
  dataDir: join(currentDirectory, ".kora-data"),
  token: koraToken,
  port: enginePort,
  maxMemoryBytes: 32 * 1024 * 1024,
  evictionPolicy: "lru",
  expirationIntervalMs: 1000,
  snapshotIntervalMs: 30_000,
  compactionIntervalMs: 300_000
});
const kora = new KoraClient({ url: `http://127.0.0.1:${enginePort}`, token: koraToken });
const page = await readFile(join(currentDirectory, "public", "index.html"));

const app = createServer((request, response) => {
  void handle(request, response);
});

await new Promise((resolve, reject) => {
  app.once("error", reject);
  app.listen(appPort, "127.0.0.1", resolve);
});

process.stdout.write(`Kora demo is running at http://localhost:${appPort}\n`);
process.stdout.write("Demo login: sanket@kora.dev / kora123\n");

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await new Promise((resolve, reject) => app.close((error) => error ? reject(error) : resolve()));
  await engine.close();
}

process.on("SIGINT", () => void stop().then(() => process.exit(0)));
process.on("SIGTERM", () => void stop().then(() => process.exit(0)));

async function handle(request, response) {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  if (request.method === "GET" && url.pathname === "/") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(page);
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/login") {
    const body = await readJson(request);
    const address = request.socket.remoteAddress ?? "unknown";
    const limit = await kora.consumeRateLimit(`login:rate:${address}`, 5, 60);
    if (!limit.allowed) {
      sendJson(response, 429, { ok: false, message: "Too many attempts. Try again in a minute.", limit });
      return;
    }
    if (body.email !== "sanket@kora.dev" || body.password !== "kora123") {
      sendJson(response, 401, { ok: false, message: "Wrong demo email or password.", limit });
      return;
    }
    const sessionId = randomUUID();
    const session = {
      id: sessionId,
      user: { id: "user_001", name: "Sanket Padhyal", email: body.email },
      createdAt: new Date().toISOString()
    };
    await kora.set(`session:${sessionId}`, session, { ttlSeconds: 900 });
    sendJson(response, 200, { ok: true, message: "Login succeeded. Your fake session is now stored in Kora.", session, limit });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/stats") {
    sendJson(response, 200, await kora.stats());
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/session") {
    const sessionId = url.searchParams.get("id");
    if (!sessionId) {
      sendJson(response, 400, { ok: false, message: "Session id is required." });
      return;
    }
    const session = await kora.get(`session:${sessionId}`);
    sendJson(response, session ? 200 : 404, { ok: Boolean(session), session });
    return;
  }
  sendJson(response, 404, { ok: false, message: "Not found." });
}

async function readJson(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > 16_384) throw new Error("Request body is too large.");
    chunks.push(buffer);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("Request body must be an object.");
  return value;
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(payload));
}
