import type { SequenceModel } from "@/analyzer/sequence/types";

interface MemoryCacheEntry {
  model: SequenceModel;
  expiresAt: number;
}

export class SequenceMemoryCache {
  private readonly entries = new Map<string, MemoryCacheEntry>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
  ) {}

  get size(): number {
    this.evictExpired();
    return this.entries.size;
  }

  get(key: string): SequenceModel | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }

    if (Date.now() > entry.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }

    this.entries.delete(key);
    this.entries.set(key, entry);

    return entry.model;
  }

  set(key: string, model: SequenceModel): void {
    this.evictExpired();

    if (this.entries.has(key)) {
      this.entries.delete(key);
    }

    const expiresAt =
      Number.isFinite(this.ttlMs) && this.ttlMs > 0
        ? Date.now() + this.ttlMs
        : Number.POSITIVE_INFINITY;

    this.entries.set(key, { model, expiresAt });

    this.evictOverflow();
  }

  delete(key: string): boolean {
    return this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  private evictExpired(): void {
    const now = Date.now();

    for (const [key, entry] of this.entries) {
      if (now > entry.expiresAt) {
        this.entries.delete(key);
      }
    }
  }

  private evictOverflow(): void {
    if (this.maxEntries < 1) {
      this.entries.clear();
      return;
    }

    while (this.entries.size > this.maxEntries) {
      const firstKey = this.entries.keys().next().value;
      if (firstKey === undefined) {
        return;
      }
      this.entries.delete(firstKey);
    }
  }
}
