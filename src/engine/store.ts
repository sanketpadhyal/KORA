import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type EvictionPolicy = "lru" | "noeviction";
type RecordEntry = { value: JsonValue; expiresAt: number | null; lastAccessedAt: number; sizeBytes: number };
type JournalEvent = { type: "set"; key: string; value: JsonValue; expiresAt: number | null } | { type: "delete"; key: string };
type Snapshot = { version: 2; records: Array<[string, RecordEntry]> };
type LegacySnapshot = { version: 1; records: Array<[string, { value: JsonValue; expiresAt: number | null }]> };
export type StoreEntry<T = JsonValue> = { value: T; expiresAt: number | null };
export type StoreStats = { keys: number; expiringKeys: number; memoryBytes: number; maxMemoryBytes: number | null; evictionPolicy: EvictionPolicy; startedAt: string; uptimeSeconds: number };
export type RateLimitResult = { allowed: boolean; remaining: number; resetAt: number };
export type KoraStoreOptions = { dataDir: string; maxMemoryBytes?: number; evictionPolicy?: EvictionPolicy };

export class KoraStore {
  private readonly records = new Map<string, RecordEntry>();
  private readonly aofPath: string;
  private readonly snapshotPath: string;
  private readonly maxMemoryBytes: number;
  private readonly evictionPolicy: EvictionPolicy;
  private mutationChain: Promise<void> = Promise.resolve();
  private memoryBytes = 0;
  private readonly startedAt = new Date();
  private readonly dataDir: string;
  private accessSequence = Date.now();

  constructor(options: string | KoraStoreOptions) {
    const resolved = typeof options === "string" ? { dataDir: options } : options;
    if (!resolved.dataDir) throw new Error("dataDir is required");
    if (resolved.maxMemoryBytes !== undefined && (!Number.isSafeInteger(resolved.maxMemoryBytes) || resolved.maxMemoryBytes < 1)) throw new Error("maxMemoryBytes must be a positive integer");
    this.dataDir = resolved.dataDir;
    this.aofPath = join(resolved.dataDir, "appendonly.aof");
    this.snapshotPath = join(resolved.dataDir, "snapshot.json");
    this.maxMemoryBytes = resolved.maxMemoryBytes ?? Number.POSITIVE_INFINITY;
    this.evictionPolicy = resolved.evictionPolicy ?? "lru";
  }

  async open(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    await this.loadSnapshot();
    await this.replayJournal();
    this.dropExpired();
    this.recalculateMemory();
    this.accessSequence = Math.max(this.accessSequence, ...Array.from(this.records.values()).map((record) => record.lastAccessedAt));
    await this.enforceCapacity();
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<StoreEntry<T>> {
    this.assertKey(key);
    const json = this.serialize(value);
    const expiresAt = this.createExpiry(ttlSeconds);
    return this.enqueue(async () => {
      const next = this.createRecord(key, json, expiresAt);
      await this.enforceCapacity(next.sizeBytes, key);
      await this.append({ type: "set", key, value: json, expiresAt });
      this.replace(key, next);
      return { value: this.clone(json) as T, expiresAt };
    });
  }

  async get<T>(key: string): Promise<StoreEntry<T> | null> {
    this.assertKey(key);
    return this.enqueue(async () => {
      const record = this.records.get(key);
      if (!record) return null;
      if (this.isExpired(record)) {
        await this.deleteRecord(key);
        return null;
      }
      record.lastAccessedAt = this.nextAccessSequence();
      return { value: this.clone(record.value) as T, expiresAt: record.expiresAt };
    });
  }

  async delete(key: string): Promise<boolean> { this.assertKey(key); return this.enqueue(async () => this.deleteRecord(key)); }
  async exists(key: string): Promise<boolean> { return (await this.get(key)) !== null; }

  async increment(key: string, delta: number): Promise<number> {
    this.assertKey(key);
    if (!Number.isFinite(delta)) throw new Error("delta must be a finite number");
    return this.enqueue(async () => {
      const record = this.records.get(key);
      if (record && this.isExpired(record)) await this.deleteRecord(key);
      const current = this.records.get(key);
      const previous = current?.value ?? 0;
      if (typeof previous !== "number" || !Number.isFinite(previous)) throw new Error("value is not a finite number");
      const value = previous + delta;
      if (!Number.isFinite(value)) throw new Error("increment would create a non-finite number");
      const expiresAt = current?.expiresAt ?? null;
      const next = this.createRecord(key, value, expiresAt);
      await this.enforceCapacity(next.sizeBytes, key);
      await this.append({ type: "set", key, value, expiresAt });
      this.replace(key, next);
      return value;
    });
  }

  async expire(key: string, ttlSeconds: number): Promise<boolean> {
    this.assertKey(key);
    const expiresAt = this.createExpiry(ttlSeconds);
    return this.enqueue(async () => {
      const record = this.records.get(key);
      if (!record) return false;
      if (this.isExpired(record)) {
        await this.deleteRecord(key);
        return false;
      }
      const next = this.createRecord(key, record.value, expiresAt);
      await this.append({ type: "set", key, value: next.value, expiresAt });
      this.replace(key, next);
      return true;
    });
  }

  async consumeRateLimit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    this.assertKey(key);
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("limit must be a positive integer");
    if (!Number.isFinite(windowSeconds) || windowSeconds < 0) throw new Error("windowSeconds must be a non-negative finite number");
    const newExpiry = this.createExpiry(windowSeconds);
    if (newExpiry === null) throw new Error("windowSeconds is required");
    return this.enqueue(async () => {
      const record = this.records.get(key);
      if (record && this.isExpired(record)) await this.deleteRecord(key);
      const current = this.records.get(key);
      const count = current?.value ?? 0;
      if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) throw new Error("rate limit key must contain a non-negative integer");
      const expiresAt = current?.expiresAt ?? newExpiry;
      if (count >= limit) return { allowed: false, remaining: 0, resetAt: expiresAt };
      const value = count + 1;
      const next = this.createRecord(key, value, expiresAt);
      await this.enforceCapacity(next.sizeBytes, key);
      await this.append({ type: "set", key, value, expiresAt });
      this.replace(key, next);
      return { allowed: true, remaining: limit - value, resetAt: expiresAt };
    });
  }

  async ttl(key: string): Promise<number> {
    this.assertKey(key);
    return this.enqueue(async () => {
      const record = this.records.get(key);
      if (!record) return -2;
      if (this.isExpired(record)) {
        await this.deleteRecord(key);
        return -2;
      }
      if (record.expiresAt === null) return -1;
      return Math.max(0, Math.ceil((record.expiresAt - Date.now()) / 1000));
    });
  }

  async pruneExpired(): Promise<number> { return this.enqueue(async () => this.prune()); }
  async snapshot(): Promise<void> { await this.enqueue(async () => { await this.prune(); await this.writeSnapshot(); }); }
  async compact(): Promise<void> {
    await this.enqueue(async () => {
      await this.prune();
      await this.writeSnapshot();
      const temporaryPath = `${this.aofPath}.tmp`;
      await writeFile(temporaryPath, "", "utf8");
      await rename(temporaryPath, this.aofPath);
    });
  }

  async stats(): Promise<StoreStats> {
    return this.enqueue(async () => {
      await this.prune();
      let expiringKeys = 0;
      for (const record of this.records.values()) if (record.expiresAt !== null) expiringKeys += 1;
      return { keys: this.records.size, expiringKeys, memoryBytes: this.memoryBytes, maxMemoryBytes: Number.isFinite(this.maxMemoryBytes) ? this.maxMemoryBytes : null, evictionPolicy: this.evictionPolicy, startedAt: this.startedAt.toISOString(), uptimeSeconds: Math.floor((Date.now() - this.startedAt.getTime()) / 1000) };
    });
  }

  async close(): Promise<void> { await this.compact(); }

  private async loadSnapshot(): Promise<void> {
    try {
      const snapshot = JSON.parse(await readFile(this.snapshotPath, "utf8")) as Snapshot | LegacySnapshot;
      if ((snapshot.version !== 1 && snapshot.version !== 2) || !Array.isArray(snapshot.records)) throw new Error("snapshot format is invalid");
      for (const [key, record] of snapshot.records) {
        this.assertKey(key);
        if (!this.isRecord(record)) throw new Error("snapshot contains an invalid record");
        this.records.set(key, this.normalizeRecord(key, record));
      }
    } catch (error) { if (!this.isMissingFile(error)) throw error; }
  }

  private async replayJournal(): Promise<void> {
    try { for (const line of (await readFile(this.aofPath, "utf8")).split("\n").filter(Boolean)) this.apply(JSON.parse(line) as JournalEvent); }
    catch (error) { if (!this.isMissingFile(error)) throw error; }
  }

  private apply(event: JournalEvent): void {
    if (event.type === "delete") { this.records.delete(event.key); return; }
    if (event.type !== "set") throw new Error("journal contains an unknown operation");
    this.assertKey(event.key);
    this.records.set(event.key, this.createRecord(event.key, event.value, event.expiresAt));
  }

  private async append(event: JournalEvent): Promise<void> { await appendFile(this.aofPath, `${JSON.stringify(event)}\n`, { encoding: "utf8", flush: true }); }
  private async deleteRecord(key: string): Promise<boolean> {
    const record = this.records.get(key);
    if (!record) return false;
    await this.append({ type: "delete", key });
    this.records.delete(key);
    this.memoryBytes -= record.sizeBytes;
    return true;
  }
  private replace(key: string, record: RecordEntry): void {
    const previous = this.records.get(key);
    if (previous) this.memoryBytes -= previous.sizeBytes;
    this.records.set(key, record);
    this.memoryBytes += record.sizeBytes;
  }
  private async enforceCapacity(incomingBytes = 0, replacementKey?: string): Promise<void> {
    const replacementBytes = replacementKey ? this.records.get(replacementKey)?.sizeBytes ?? 0 : 0;
    while (this.memoryBytes - replacementBytes + incomingBytes > this.maxMemoryBytes) {
      if (this.evictionPolicy === "noeviction") throw new Error("memory limit exceeded");
      const candidate = Array.from(this.records.entries()).filter(([key]) => key !== replacementKey).sort((a, b) => a[1].lastAccessedAt - b[1].lastAccessedAt)[0];
      if (!candidate) throw new Error("memory limit exceeded");
      await this.deleteRecord(candidate[0]);
    }
  }
  private async prune(): Promise<number> { let removed = 0; for (const [key, record] of this.records) if (this.isExpired(record) && await this.deleteRecord(key)) removed += 1; return removed; }
  private async writeSnapshot(): Promise<void> {
    const snapshot: Snapshot = { version: 2, records: Array.from(this.records.entries()).map(([key, value]) => [key, this.clone(value)]) };
    const temporaryPath = `${this.snapshotPath}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(snapshot), "utf8");
    await rename(temporaryPath, this.snapshotPath);
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> { const next = this.mutationChain.then(operation); this.mutationChain = next.then(() => undefined, () => undefined); return next; }
  private createRecord(key: string, value: JsonValue, expiresAt: number | null): RecordEntry { return { value: this.clone(value), expiresAt, lastAccessedAt: this.nextAccessSequence(), sizeBytes: this.measure(key, value) }; }
  private normalizeRecord(key: string, record: RecordEntry | { value: JsonValue; expiresAt: number | null }): RecordEntry { return { value: record.value, expiresAt: record.expiresAt, lastAccessedAt: "lastAccessedAt" in record && typeof record.lastAccessedAt === "number" ? record.lastAccessedAt : this.nextAccessSequence(), sizeBytes: this.measure(key, record.value) }; }
  private dropExpired(): void { for (const [key, record] of this.records) if (this.isExpired(record)) this.records.delete(key); }
  private recalculateMemory(): void { this.memoryBytes = Array.from(this.records.values()).reduce((total, record) => total + record.sizeBytes, 0); }
  private createExpiry(ttlSeconds: number | undefined): number | null { if (ttlSeconds === undefined) return null; if (!Number.isFinite(ttlSeconds) || ttlSeconds < 0) throw new Error("ttlSeconds must be a non-negative finite number"); return Date.now() + Math.round(ttlSeconds * 1000); }
  private assertKey(key: string): void { if (typeof key !== "string" || !key) throw new Error("key must be a non-empty string"); if (Buffer.byteLength(key, "utf8") > 512) throw new Error("key must be 512 bytes or fewer"); }
  private serialize(value: unknown): JsonValue { if (value === undefined) throw new Error("value cannot be undefined"); try { return JSON.parse(JSON.stringify(value)) as JsonValue; } catch { throw new Error("value must be JSON-serializable"); } }
  private measure(key: string, value: JsonValue): number { return Buffer.byteLength(key, "utf8") + Buffer.byteLength(JSON.stringify(value), "utf8"); }
  private nextAccessSequence(): number { this.accessSequence += 1; return this.accessSequence; }
  private clone<T>(value: T): T { return structuredClone(value); }
  private isExpired(record: RecordEntry): boolean { return record.expiresAt !== null && record.expiresAt <= Date.now(); }
  private isRecord(value: unknown): value is RecordEntry { if (!value || typeof value !== "object") return false; const record = value as Record<string, unknown>; return "value" in record && (record.expiresAt === null || typeof record.expiresAt === "number"); }
  private isMissingFile(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"; }
}
