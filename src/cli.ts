#!/usr/bin/env node
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { startKoraServer } from "./engine/server.js";
import type { EvictionPolicy } from "./engine/store.js";
import { scaffoldProject } from "./scaffold.js";

type PackageManifest = {
  name: string;
  version: string;
};

async function main(): Promise<void> {
  const [command, ...argumentsList] = process.argv.slice(2);
  if (command === "init") {
    const directory = argumentsList[0] ?? "kora";
    const flags = parseFlags(argumentsList.slice(1));
    await initialize(directory, flags.packageSource);
    return;
  }
  if (command === "start") {
    await start(argumentsList);
    return;
  }
  printUsage();
  process.exitCode = 1;
}

async function initialize(directory: string, packageSource?: string): Promise<void> {
  const destination = resolve(process.cwd(), directory);
  if (existsSync(destination)) {
    throw new Error(`${destination} already exists`);
  }
  const manifest = await loadManifest();
  await scaffoldProject({
    destination,
    packageName: manifest.name,
    packageSpec: packageSource ?? `^${manifest.version}`
  });
  process.stdout.write(`Kora deployment files created in ${destination}\n`);
  process.stdout.write(`Read ${destination}/README.md for Railway deployment steps.\n`);
}

async function start(argumentsList: string[]): Promise<void> {
  const flags = parseFlags(argumentsList);
  const token = flags.token ?? process.env.KORA_TOKEN;
  const port = asPort(flags.port ?? process.env.PORT ?? process.env.KORA_PORT ?? "8080");
  const dataDir = flags.dataDir ?? process.env.KORA_DATA_DIR ?? ".kora-data";
  const snapshotIntervalMs = asPositiveInteger(flags.snapshotIntervalMs ?? process.env.KORA_SNAPSHOT_INTERVAL_MS ?? "300000");
  const compactionIntervalMs = asPositiveInteger(flags.compactionIntervalMs ?? process.env.KORA_COMPACTION_INTERVAL_MS ?? "3600000");
  const expirationIntervalMs = asPositiveInteger(flags.expirationIntervalMs ?? process.env.KORA_EXPIRATION_INTERVAL_MS ?? "1000");
  const maxMemoryMb = flags.maxMemoryMb ?? process.env.KORA_MAX_MEMORY_MB;
  const maxMemoryBytes = maxMemoryMb ? asPositiveInteger(maxMemoryMb) * 1024 * 1024 : undefined;
  const evictionPolicy = asEvictionPolicy(flags.evictionPolicy ?? process.env.KORA_EVICTION_POLICY ?? "lru");
  if (!token) {
    throw new Error("KORA_TOKEN is required");
  }
  const runtime = await startKoraServer({ token, port, dataDir, snapshotIntervalMs, compactionIntervalMs, expirationIntervalMs, maxMemoryBytes, evictionPolicy });
  process.stdout.write(`Kora engine listening on port ${port}\n`);
  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) {
      return;
    }
    stopping = true;
    await runtime.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
}

function parseFlags(argumentsList: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let index = 0; index < argumentsList.length; index += 2) {
    const flag = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error(`invalid argument ${flag ?? ""}`);
    }
    const key = flag.slice(2).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
    flags[key] = value;
  }
  return flags;
}

function asPort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("port must be an integer between 1 and 65535");
  }
  return port;
}

function asPositiveInteger(value: string): number {
  const integer = Number(value);
  if (!Number.isInteger(integer) || integer < 1) {
    throw new Error("snapshot interval must be a positive integer in milliseconds");
  }
  return integer;
}

function asEvictionPolicy(value: string): EvictionPolicy {
  if (value !== "lru" && value !== "noeviction") {
    throw new Error("eviction policy must be lru or noeviction");
  }
  return value;
}

async function loadManifest(): Promise<PackageManifest> {
  const path = new URL("../package.json", import.meta.url);
  const source = await readFile(path, "utf8");
  return JSON.parse(source) as PackageManifest;
}

function printUsage(): void {
  process.stdout.write("Usage:\n");
  process.stdout.write("  kora init [directory] [--package-source package-spec]\n");
  process.stdout.write("  kora start [--port 8080] [--data-dir ./data] [--max-memory-mb 128] [--eviction-policy lru] [--token secret]\n");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Kora failed";
  process.stderr.write(`Kora error: ${message}\n`);
  process.exitCode = 1;
});
