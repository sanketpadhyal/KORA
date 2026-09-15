import { mkdir, readFile, rename, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";

type StoredValue = string | number | boolean | null | StoredValue[] | { [key: string]: StoredValue };

type RecordEntry = {
  value: StoredValue;
  expiresAt: number | null;
};

type SetEvent = {
  type: "set";
  key: string;
  value: StoredValue;
  expiresAt: number | null;
};

type DeleteEvent = {
  type: "delete";
  key: string;
};

type JournalEvent = SetEvent | DeleteEvent;

type Snapshot = {
  version: 1;
  records: Array<[string, RecordEntry]>;
};

export type StoreEntry<T = StoredValue> = {
  value: T;
  expiresAt: number | null;
};

export type StoreStats = {
  keys: number;
  expiringKeys: number;
  startedAt: string;
  uptimeSeconds: number;
};

export class KoraStore {
  private readonly records = new Map<string, RecordEntry>();
  private readonly aofPath: string;
  private readonly snapshotPath: string;
  private mutationChain: Promise<void> = Promise.resolve();
  private readonly startedAt = new Date();

  constructor(private readonly dataDir: string) {
    this.aofPath = join(dataDir, "appendonly.aof");
    this.snapshotPath = join(dataDir, "snapshot.json");
  }

  async open(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    await this.loadSnapshot();
    await this.replayJournal();
    this.removeExpired();
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<StoreEntry<T>> {
    this.assertKey(key);
    const serializableValue = this.serializeValue(value) as StoredValue;
    const expiresAt = this.createExpiry(ttlSeconds);
    await this.enqueue(async () => {
      await this.append({ type: "set", key, value: serializableValue, expiresAt });
      this.records.set(key, { value: serializableValue, expiresAt });
    });
    return { value: this.clone(serializableValue) as T, expiresAt };
  }

  async get<T>(key: string): Promise<StoreEntry<T> | null> {
    this.assertKey(key);
    return this.enqueue(async () => {
      const record = this.records.get(key);
      if (!record) {
        return null;
      }
      if (this.isExpired(record)) {
        this.records.delete(key);
        await this.append({ type: "delete", key });
        return null;
      }
      return { value: this.clone(record.value) as T, expiresAt: record.expiresAt };
    });

  }

  async delete(key: string): Promise<boolean> {
    this.assertKey(key);
    return this.enqueue(async () => {
      const current = this.getWithoutJournal(key);
      if (!current) {
        return false;
      }
      await this.append({ type: "delete", key });
      this.records.delete(key);
      return true;
    });
  }

  async increment(key: string, delta: number): Promise<number> {
    this.assertKey(key);
    if (!Number.isFinite(delta)) {
      throw new Error("delta must be a finite number");
    }
    return this.enqueue(async () => {
      const current = this.getWithoutJournal(key);
      const next = (current?.value ?? 0) as unknown;
      if (typeof next !== "number" || !Number.isFinite(next)) {
        throw new Error("value is not a finite number");
      }
      const value = next + delta;
      if (!Number.isFinite(value)) {
        throw new Error("increment would create a non-finite number");
      }
      const expiresAt = current?.expiresAt ?? null;
      await this.append({ type: "set", key, value, expiresAt });
      this.records.set(key, { value, expiresAt });
      return value;
    });
  }

  async snapshot(): Promise<void> {
    await this.mutationChain;
    this.removeExpired();
    const snapshot: Snapshot = {
      version: 1,
      records: Array.from(this.records.entries()).map(([key, record]) => [key, this.clone(record)])
    };
    const temporaryPath = `${this.snapshotPath}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(snapshot), "utf8");
    await rename(temporaryPath, this.snapshotPath);
  }

  stats(): StoreStats {
    this.removeExpired();
    let expiringKeys = 0;
    for (const record of this.records.values()) {
      if (record.expiresAt !== null) {
        expiringKeys += 1;
      }
    }
    return {
      keys: this.records.size,
      expiringKeys,
      startedAt: this.startedAt.toISOString(),
      uptimeSeconds: Math.floor((Date.now() - this.startedAt.getTime()) / 1000)
    };
  }

  async close(): Promise<void> {
    await this.snapshot();
  }

  private async loadSnapshot(): Promise<void> {
    try {
      const source = await readFile(this.snapshotPath, "utf8");
      const snapshot = JSON.parse(source) as Snapshot;
      if (snapshot.version !== 1 || !Array.isArray(snapshot.records)) {
        throw new Error("snapshot format is invalid");
      }
      for (const [key, record] of snapshot.records) {
        this.assertKey(key);
        if (!this.isRecordEntry(record)) {
          throw new Error("snapshot contains an invalid record");
        }
        this.records.set(key, record);
      }
    } catch (error) {
      if (this.isMissingFile(error)) {
        return;
      }
      throw error;
    }
  }

  private async replayJournal(): Promise<void> {
    try {
      const source = await readFile(this.aofPath, "utf8");
      const lines = source.split("\n").filter(Boolean);
      for (const line of lines) {
        const event = JSON.parse(line) as JournalEvent;
        this.apply(event);
      }
    } catch (error) {
      if (this.isMissingFile(error)) {
        return;
      }
      throw error;
    }
  }

  private apply(event: JournalEvent): void {
    if (event.type === "set") {
      this.assertKey(event.key);
      if (!this.isRecordEntry(event)) {
        throw new Error("journal contains an invalid set operation");
      }
      this.records.set(event.key, { value: event.value, expiresAt: event.expiresAt });
      return;
    }
    if (event.type === "delete") {
      this.assertKey(event.key);
      this.records.delete(event.key);
      return;
    }
    throw new Error("journal contains an unknown operation");
  }

  private async append(event: JournalEvent): Promise<void> {
    await appendFile(this.aofPath, `${JSON.stringify(event)}\n`, "utf8");
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutationChain.then(operation);
    this.mutationChain = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  private getWithoutJournal(key: string): RecordEntry | null {
    const record = this.records.get(key);
    if (!record) {
      return null;
    }
    if (this.isExpired(record)) {
      this.records.delete(key);
      return null;
    }
    return record;
  }

  private removeExpired(): void {
    for (const [key, record] of this.records.entries()) {
      if (this.isExpired(record)) {
        this.records.delete(key);
      }
    }
  }

  private createExpiry(ttlSeconds: number | undefined): number | null {
    if (ttlSeconds === undefined) {
      return null;
    }
    if (!Number.isFinite(ttlSeconds) || ttlSeconds < 0) {
      throw new Error("ttlSeconds must be a non-negative finite number");
    }
    return Date.now() + Math.round(ttlSeconds * 1000);
  }

  private assertKey(key: string): void {
    if (typeof key !== "string" || key.length === 0) {
      throw new Error("key must be a non-empty string");
    }
    if (Buffer.byteLength(key, "utf8") > 512) {
      throw new Error("key must be 512 bytes or fewer");
    }
  }

  private serializeValue(value: unknown): StoredValue {
    if (value === undefined) {
      throw new Error("value cannot be undefined");
    }
    try {
      return JSON.parse(JSON.stringify(value)) as StoredValue;
    } catch {
      throw new Error("value must be JSON-serializable");
    }
  }

  private clone<T>(value: T): T {
    return structuredClone(value);
  }

  private isExpired(record: RecordEntry): boolean {
    return record.expiresAt !== null && record.expiresAt <= Date.now();
  }

  private isRecordEntry(value: unknown): value is RecordEntry {
    if (!value || typeof value !== "object") {
      return false;
    }
    const record = value as Record<string, unknown>;
    return "value" in record && (record.expiresAt === null || typeof record.expiresAt === "number");
  }

  private isMissingFile(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
  }
}
