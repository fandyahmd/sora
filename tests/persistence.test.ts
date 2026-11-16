import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { RequestChannels } from '../src/services/channels.js';
import { MemoryStore } from './memory-store.js';

test('failed persistence removes a newly posted panel and prevents destructive teardown', async () => {
  const store = new MemoryStore();
  const deleted: string[] = [];
  const client = {
    music: { manager: { players: new Map() } },
    channels: { fetch: async () => ({ guildId: 'g', type: 0 }), memberPermissions: async () => ({ has: () => true }),
      delete: async (id: string) => { deleted.push(id); } },
    guilds: { fetchSelf: async () => ({}) },
    messages: { write: async () => ({ id: 'new-panel' }), delete: async (id: string) => { deleted.push(id); } },
  };
  const channels = new RequestChannels(client as never, {
    get: id => store.get(id), entries: () => store.entries(),
    set: async () => { throw new Error('save rejected'); },
    clear: async () => { throw new Error('delete rejected'); },
  });
  await assert.rejects(() => channels.setup('g', 'text'), /save rejected/);
  assert.deepEqual(deleted, ['new-panel']);
  assert.equal(store.get('g'), undefined);
  await store.set('g', { requestChannelId: 'text', panelMessageId: 'panel', channelOwned: true });
  await assert.rejects(() => channels.teardown('g'), /delete rejected/);
  assert.deepEqual(deleted, ['new-panel'], 'never delete Discord channel before PostgreSQL acknowledges removal');
  assert.equal(store.get('g')?.channelOwned, true);
});
