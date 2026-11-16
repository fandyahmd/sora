import type { GuildBinding } from '../src/services/db.js';

/** Offline Discord tests only. Durability and atomicity are covered by db.integration.test.ts. */
export class MemoryStore {
  private static readonly stores = new Map<string, { bindings: Map<string, GuildBinding>; autoplay: Set<string> }>();
  private readonly state;
  constructor(key: string = crypto.randomUUID()) {
    if (!MemoryStore.stores.has(key)) MemoryStore.stores.set(key, { bindings: new Map(), autoplay: new Set() });
    this.state = MemoryStore.stores.get(key)!;
  }
  get(id: string) { return this.state.bindings.get(id); }
  entries() { return [...this.state.bindings.entries()]; }
  async set(id: string, binding: GuildBinding) {
    this.state.bindings.set(id, { requestChannelId: binding.requestChannelId, panelMessageId: binding.panelMessageId,
      ...(binding.channelOwned ? { channelOwned: true } : {}) });
  }
  async clear(id: string) { this.state.bindings.delete(id); this.state.autoplay.delete(id); }
  has(id: string) { return this.state.autoplay.has(id); }
  async toggleAutoplay(id: string) {
    const enabled = !this.has(id);
    if (enabled) this.state.autoplay.add(id); else this.state.autoplay.delete(id);
    return enabled;
  }
}
