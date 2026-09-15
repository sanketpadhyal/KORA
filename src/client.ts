export type KoraClientOptions = {
  url: string;
  token: string;
  pathPrefix?: string;
};

export type SetOptions = {
  ttlSeconds?: number;
};

export type KoraEntry<T> = {
  value: T;
  expiresAt: number | null;
};

export type KoraStats = {
  keys: number;
  expiringKeys: number;
  memoryBytes: number;
  maxMemoryBytes: number | null;
  evictionPolicy: "lru" | "noeviction";
  startedAt: string;
  uptimeSeconds: number;
};

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  resetAt: number;
};

type ErrorPayload = {
  error?: string;
};

export class KoraClient {
  private readonly url: string;
  private readonly token: string;
  private readonly pathPrefix: string;

  constructor(options: KoraClientOptions) {
    this.url = options.url.replace(/\/+$/, "");
    this.token = options.token;
    this.pathPrefix = this.normalizePathPrefix(options.pathPrefix ?? "");
  }

  async get<T>(key: string): Promise<KoraEntry<T> | null> {
    const response = await this.request(`/v1/keys/${encodeURIComponent(key)}`, { method: "GET" }, [404]);
    if (response.status === 404) {
      return null;
    }
    return (await response.json()) as KoraEntry<T>;
  }

  async set<T>(key: string, value: T, options: SetOptions = {}): Promise<KoraEntry<T>> {
    const response = await this.request(`/v1/keys/${encodeURIComponent(key)}`, {
      method: "PUT",
      body: JSON.stringify({ value, ttlSeconds: options.ttlSeconds })
    });
    return (await response.json()) as KoraEntry<T>;
  }

  async delete(key: string): Promise<boolean> {
    const response = await this.request(`/v1/keys/${encodeURIComponent(key)}`, { method: "DELETE" }, [404]);
    return response.status !== 404;
  }

  async increment(key: string, delta = 1): Promise<number> {
    const response = await this.request(`/v1/keys/${encodeURIComponent(key)}/incr`, {
      method: "POST",
      body: JSON.stringify({ delta })
    });
    const payload = (await response.json()) as { value: number };
    return payload.value;
  }

  async exists(key: string): Promise<boolean> {
    return (await this.get(key)) !== null;
  }

  async expire(key: string, ttlSeconds: number): Promise<boolean> {
    const response = await this.request(`/v1/keys/${encodeURIComponent(key)}/expire`, {
      method: "POST",
      body: JSON.stringify({ ttlSeconds })
    }, [404]);
    if (response.status === 404) {
      return false;
    }
    return ((await response.json()) as { expires: boolean }).expires;
  }

  async ttl(key: string): Promise<number> {
    const response = await this.request(`/v1/keys/${encodeURIComponent(key)}/ttl`, { method: "GET" });
    return ((await response.json()) as { ttlSeconds: number }).ttlSeconds;
  }

  async snapshot(): Promise<void> {
    await this.request("/v1/snapshot", { method: "POST" });
  }

  async compact(): Promise<void> {
    await this.request("/v1/compact", { method: "POST" });
  }

  async consumeRateLimit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    const response = await this.request(`/v1/rate-limits/${encodeURIComponent(key)}`, {
      method: "POST",
      body: JSON.stringify({ limit, windowSeconds })
    }, [429]);
    return (await response.json()) as RateLimitResult;
  }

  async stats(): Promise<KoraStats> {
    const response = await this.request("/v1/stats", { method: "GET" });
    return (await response.json()) as KoraStats;
  }

  private async request(path: string, init: RequestInit, acceptedStatuses: number[] = []): Promise<Response> {
    const response = await fetch(`${this.url}${this.pathPrefix}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        ...(init.headers ?? {})
      }
    });
    if (!response.ok && !acceptedStatuses.includes(response.status)) {
      let message = `Kora request failed with ${response.status}`;
      try {
        const payload = (await response.json()) as ErrorPayload;
        if (payload.error) {
          message = payload.error;
        }
      } catch {
        message = `Kora request failed with ${response.status}`;
      }
      throw new Error(message);
    }
    return response;
  }

  private normalizePathPrefix(pathPrefix: string): string {
    if (!pathPrefix || pathPrefix === "/") {
      return "";
    }
    return `/${pathPrefix.replace(/^\/+|\/+$/g, "")}`;
  }
}
