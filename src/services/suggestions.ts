import { randomUUID } from 'node:crypto';

/** Cache full tracks, avoiding a second, potentially flaky URL lookup. */
export class Suggestions<T> {
  private readonly entries = new Map<string, { guildId: string; track: T; expires: number }>();

  constructor(private readonly ttl = 300_000) {}

  put(guildId: string, track: T, now = Date.now()): string {
    for (const [key, entry] of this.entries) {
      if (entry.expires <= now) this.entries.delete(key);
    }
    // ponytail: bounded in-memory cache; use shared storage if running multiple workers.
    if (this.entries.size >= 2500) this.entries.delete(this.entries.keys().next().value!);
    const value = `track:${randomUUID()}`;
    this.entries.set(value, { guildId, track, expires: now + this.ttl });
    return value;
  }

  get(guildId: string, value: string, now = Date.now()): T | undefined {
    const entry = this.entries.get(value);
    if (!entry || entry.guildId !== guildId) return undefined;
    if (entry.expires <= now) {
      this.entries.delete(value);
      return undefined;
    }
    return entry.track;
  }
}
