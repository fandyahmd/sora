import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Hoshimi } from 'hoshimi';
import { GuildStore } from '../src/services/db.js';
import { MusicService } from '../src/services/music.js';

test('autoplay defaults off, flips per guild, and survives a restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sora-autoplay-'));
  try {
    const store = new GuildStore(join(dir, 'sora.sqlite'));
    assert.equal(store.has('guild-a'), false); // Off by default, matching Hoshimi.
    assert.equal(store.toggleAutoplay('guild-a'), true);
    assert.equal(store.has('guild-a'), true);
    assert.equal(store.has('guild-b'), false); // Per guild, never global.
    assert.equal(store.toggleAutoplay('guild-a'), false);
    assert.equal(store.toggleAutoplay('guild-a'), true);

    const restored = new GuildStore(join(dir, 'sora.sqlite')); // A restart must not lose the choice.
    assert.equal(restored.has('guild-a'), true);
    assert.equal(restored.has('guild-b'), false);

    // An unknown guild is simply off, never an error.
    assert.equal(restored.has('guild-never-seen'), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('toggling applies to a live player and is re-applied when the player is recreated', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sora-autoplay-'));
  try {
    const store = new GuildStore(join(dir, 'sora.sqlite'));
    const written: unknown[] = [];
    const player = {
      options: { voiceId: 'voice-a' }, connected: true,
      data: { set: async (key: string, value: unknown) => { written.push([key, value]); } },
      queue: { add: async () => {}, current: null },
      isPlaying: () => false, isPaused: () => false,
      play: async () => {},
    };
    const players = new Map<string, typeof player>([['guild-a', player]]);
    const manager = {
      isUsable: () => true, players,
      createPlayer: () => { players.set('guild-a', player); return player; },
      search: async () => ({ tracks: [{ encoded: 'audio', info: { title: 'test' } }], exception: null }),
    };
    const music = new MusicService(manager as never, undefined, store);
    const ctx = { guildId: 'guild-a', channelId: 'text-a', author: { id: 'user-a' }, member: { voice: async () => ({ channelId: 'voice-a' }) } };

    assert.equal(await music.toggleAutoplay('guild-a'), true);
    assert.deepEqual(written, [['enabledAutoplay', true]]);

    // A destroyed player forgets the flag, so the next queued track restores it.
    players.delete('guild-a');
    written.length = 0;
    await music.play(ctx as never, 'lofi mix');
    assert.deepEqual(written, [['enabledAutoplay', true]]);

    assert.equal(await music.toggleAutoplay('guild-a'), false);
    assert.deepEqual(written.at(-1), ['enabledAutoplay', false]);
    written.length = 0;
    players.delete('guild-a');
    await music.play(ctx as never, 'lofi mix');
    assert.deepEqual(written, [], 'a guild with autoplay off must not touch player storage');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Hoshimi ships the autoplay hook this feature leans on, and it stays off until asked', () => {
  const manager = new Hoshimi({ nodes: [{ host: 'localhost', port: 2333, password: 'unused' }], sendPayload: async () => {} });
  assert.equal(manager.options.queueOptions.autoPlay, false);
  assert.equal(typeof manager.options.queueOptions.autoplayFn, 'function');
  assert.equal(manager.options.queueOptions.maxHistory, 25); // What autoplay dedupes against.
});
