import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("loads snapshots created by the first Kora release", async () => {
  const directory = await createDirectory();
  try {
    await writeFile(join(directory, "snapshot.json"), JSON.stringify({
      version: 1,
      records: [["legacy", { value: { migrated: true }, expiresAt: null }]]
    }));
    const store = new KoraStore(directory);
    await store.open();
    assert.deepEqual(await store.get("legacy"), { value: { migrated: true }, expiresAt: null });
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

test("enforces noeviction limits without losing the previous value", async () => {
  const directory = await createDirectory();
  try {
    const store = new KoraStore({ dataDir: directory, maxMemoryBytes: 12, evictionPolicy: "noeviction" });
    await store.open();
    await store.set("small", "one");
    await assert.rejects(store.set("large", "this cannot fit"), /memory limit exceeded/);
    assert.deepEqual(await store.get("small"), { value: "one", expiresAt: null });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("evicts least recently used entries and compacts durable history", async () => {
  const directory = await createDirectory();
  try {
    const store = new KoraStore({ dataDir: directory, maxMemoryBytes: 12, evictionPolicy: "lru" });
    await store.open();
    await store.set("first", "one");
    await store.set("second", "two");
    assert.equal(await store.get("first"), null);
    assert.deepEqual(await store.get("second"), { value: "two", expiresAt: null });
    await store.compact();
    const recovered = new KoraStore({ dataDir: directory, maxMemoryBytes: 12, evictionPolicy: "lru" });
    await recovered.open();
    assert.deepEqual(await recovered.get("second"), { value: "two", expiresAt: null });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("enforces rate limits atomically with a fixed expiry window", async () => {
  const directory = await createDirectory();
  try {
    const store = new KoraStore(directory);
    await store.open();
    const results = await Promise.all(Array.from({ length: 10 }, () => store.consumeRateLimit("ip:127.0.0.1", 3, 60)));
    assert.equal(results.filter((result) => result.allowed).length, 3);
    assert.equal(results.filter((result) => !result.allowed).length, 7);
    assert.equal(new Set(results.map((result) => result.resetAt)).size, 1);
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
    assert.equal(await client.ttl("hello") > 0, true);
    assert.equal(await client.expire("hello", 120), true);
    assert.equal(await client.exists("hello"), true);
    assert.equal((await client.consumeRateLimit("limit:hello", 1, 60)).allowed, true);
    assert.equal((await client.consumeRateLimit("limit:hello", 1, 60)).allowed, false);
    await client.compact();
    const metricsResponse = await fetch(`${baseUrl}/metrics`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(metricsResponse.status, 200);
    assert.match(await metricsResponse.text(), /kora_keys \d+/);
    const rejectedResponse = await fetch(`${baseUrl}/v1/stats`);
    assert.equal(rejectedResponse.status, 401);
  } finally {
    if (runtime) {
      await runtime.close();
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("scaffolds a Railway deployment that installs and runs the Kora engine", async () => {
  const directory = await createDirectory();
  try {
    await scaffoldProject({
      destination: join(directory, "kora"),
      packageName: "@test/kora",
      packageVersion: "^0.1.0"
    });
    const packageFile = await readFile(join(directory, "kora", "package.json"), "utf8");
    const railwayFile = await readFile(join(directory, "kora", "railway.toml"), "utf8");
    const dockerFile = await readFile(join(directory, "kora", "Dockerfile"), "utf8");
    assert.match(packageFile, /@test\/kora/);
    assert.match(packageFile, /"start": "kora start"/);
    assert.match(railwayFile, /healthcheckPath = "\/health"/);
    assert.match(dockerFile, /KORA_DATA_DIR=\/data/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
