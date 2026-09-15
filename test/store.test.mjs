import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { KoraStore } from "../dist/engine/store.js";
import { startKoraServer } from "../dist/engine/server.js";
import { KoraClient } from "../dist/index.js";
import { scaffoldProject } from "../dist/scaffold.js";

async function createDirectory() {
  return mkdtemp(join(tmpdir(), "kora-test-"));
}

test("stores values and recovers them from the append-only journal", async () => {
  const directory = await createDirectory();
  try {
    const firstStore = new KoraStore(directory);
    await firstStore.open();
    await firstStore.set("profile:42", { name: "Sanket", active: true });
    const secondStore = new KoraStore(directory);
    await secondStore.open();
    assert.deepEqual(await secondStore.get("profile:42"), {
      value: { name: "Sanket", active: true },
      expiresAt: null
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("expires TTL values", async () => {
  const directory = await createDirectory();
  try {
    const store = new KoraStore(directory);
    await store.open();
    await store.set("otp", "123456", 0.02);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(await store.get("otp"), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("increments values serially", async () => {
  const directory = await createDirectory();
  try {
    const store = new KoraStore(directory);
    await store.open();
    const values = await Promise.all(Array.from({ length: 20 }, () => store.increment("counter", 1)));
    assert.equal(values.at(-1), 20);
    assert.deepEqual(await store.get("counter"), { value: 20, expiresAt: null });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("serves authenticated HTTP commands", async () => {
  const directory = await createDirectory();
  const token = "a-secure-kora-token-that-is-long-enough";
  let runtime;
  try {
    runtime = await startKoraServer({ dataDir: directory, token, port: 0, snapshotIntervalMs: 60000 });
    const address = runtime.server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const client = new KoraClient({ url: baseUrl, token, pathPrefix: "" });
    const stored = await client.set("hello", "world", { ttlSeconds: 60 });
    assert.deepEqual(await client.get("hello"), { value: "world", expiresAt: stored.expiresAt });
    const rejectedResponse = await fetch(`${baseUrl}/v1/stats`);
    assert.equal(rejectedResponse.status, 401);
  } finally {
    if (runtime) {
      await runtime.close();
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("scaffolds a Vercel gateway that forwards requests to the Kora engine", async () => {
  const directory = await createDirectory();
  const engineToken = "an-engine-token-that-is-longer-than-24";
  const gatewayToken = "a-gateway-token-that-is-longer-than-24";
  let engine;
  let gateway;
  const originalEnvironment = {
    KORA_UPSTREAM_URL: process.env.KORA_UPSTREAM_URL,
    KORA_UPSTREAM_TOKEN: process.env.KORA_UPSTREAM_TOKEN,
    KORA_GATEWAY_TOKEN: process.env.KORA_GATEWAY_TOKEN
  };
  try {
    engine = await startKoraServer({ dataDir: join(directory, "data"), token: engineToken, port: 0, snapshotIntervalMs: 60000 });
    const engineAddress = engine.server.address();
    assert.ok(engineAddress && typeof engineAddress === "object");
    await scaffoldProject({
      destination: join(directory, "kora"),
      packageName: "@test/kora",
      packageVersion: "^0.1.0"
    });
    process.env.KORA_UPSTREAM_URL = `http://127.0.0.1:${engineAddress.port}`;
    process.env.KORA_UPSTREAM_TOKEN = engineToken;
    process.env.KORA_GATEWAY_TOKEN = gatewayToken;
    const gatewayPath = join(directory, "kora", "vercel", "api", "kora", "[...path].js");
    const gatewayRequire = createRequire(join(directory, "kora", "vercel", "package.json"));
    const handler = gatewayRequire(gatewayPath);
    gateway = createServer(handler);
    await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
    const gatewayAddress = gateway.address();
    assert.ok(gatewayAddress && typeof gatewayAddress === "object");
    const client = new KoraClient({ url: `http://127.0.0.1:${gatewayAddress.port}`, token: gatewayToken });
    await client.set("gateway:check", { deployed: true }, { ttlSeconds: 60 });
    assert.deepEqual(await client.get("gateway:check"), {
      value: { deployed: true },
      expiresAt: (await client.get("gateway:check")).expiresAt
    });
  } finally {
    process.env.KORA_UPSTREAM_URL = originalEnvironment.KORA_UPSTREAM_URL;
    process.env.KORA_UPSTREAM_TOKEN = originalEnvironment.KORA_UPSTREAM_TOKEN;
    process.env.KORA_GATEWAY_TOKEN = originalEnvironment.KORA_GATEWAY_TOKEN;
    if (gateway) {
      await new Promise((resolve, reject) => gateway.close((error) => error ? reject(error) : resolve()));
    }
    if (engine) {
      await engine.close();
    }
    await rm(directory, { recursive: true, force: true });
  }
});
