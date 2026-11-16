import { MemoryStore } from './memory-store.js';
import assert from 'node:assert/strict';
import { test } from 'bun:test';
import type { Hoshimi, TrackStructure } from 'hoshimi';
import type { VoiceContext } from '../src/services/music.js';
import { MusicService } from '../src/services/music.js';
import PlayCommand from '../src/commands/music/play.js';
import { controlRows } from '../src/ui/cards.js';
import raw from '../src/events/raw.js';

function fixture(checkPermissions?: () => Promise<void>) {
  const added: unknown[] = [];
  const calls: string[] = [];
  const player = {
    options: { voiceId: 'voice-a' }, connected: false,
    queue: { add: async (tracks: unknown) => { added.push(tracks); } },
    connect: async () => { calls.push('connect'); player.connected = true; },
    isPlaying: () => false, isPaused: () => false,
    play: async () => { calls.push('play'); },
    destroy: async () => { calls.push('destroy'); },
    skip: async () => { calls.push('skip'); },
    setPaused: async (paused: boolean) => { calls.push(`paused:${paused}`); },
  };
  const players = new Map<string, typeof player>();
  const manager = {
    isUsable: () => true, players,
    createPlayer: () => { players.set('guild-a', player); return player; },
    search: async () => { calls.push('search'); return { tracks: [], exception: null }; },
  };
  const music = new MusicService(manager as unknown as Hoshimi, checkPermissions, new MemoryStore());
  const ctx = {
    guildId: 'guild-a', channelId: 'text-a', author: { id: 'user-a' },
    member: { voice: async () => ({ channelId: 'voice-a' }) },
  } as VoiceContext;
  return { music, ctx, player, players, added, calls };
}

test('cached selection connects, queues exact track, plays without search', async () => {
  const f = fixture();
  const track = { encoded: 'audio', info: { title: 'test' } } as TrackStructure;
  const choice = f.music.suggestions.put('guild-a', track);
  assert.deepEqual(await f.music.play(f.ctx, choice), [track]);
  assert.deepEqual(f.added, [[track]]);
  assert.deepEqual(f.calls, ['connect', 'play']);
});

test('voice controls reject another channel', async () => {
  const f = fixture();
  f.player.options.voiceId = 'voice-b';
  f.players.set('guild-a', f.player);
  await assert.rejects(() => f.music.control(f.ctx, 'stop'), /same voice channel/);
  assert.deepEqual(f.calls, []);
});

test('expired choice never falls back to URL search', async () => {
  const f = fixture();
  await assert.rejects(() => f.music.play(f.ctx, 'track:expired'), /expired/);
  assert.deepEqual(f.calls, []);
});

test('message context rejects missing voice before search or queue', async () => {
  const f = fixture();
  f.ctx.member!.voice = async () => undefined as never;
  await assert.rejects(() => f.music.play(f.ctx, 'song'), /Join a voice/);
  assert.deepEqual(f.calls, []);
});

test('bot voice permission denial prevents playback', async () => {
  const f = fixture(async () => { throw new Error('Sora needs Connect and Speak.'); });
  const choice = f.music.suggestions.put('guild-a', { encoded: 'audio', info: { title: 'test' } } as TrackStructure);
  await assert.rejects(() => f.music.play(f.ctx, choice), /Connect and Speak/);
  assert.deepEqual(f.calls, []);
});

test('parallel requests serialize playback until first track starts', async () => {
  const f = fixture();
  const playing = false;
  f.player.isPlaying = () => playing;
  f.player.play = async () => { await new Promise(resolve => setTimeout(resolve, 5)); (f.player.queue as { current?: unknown }).current = {}; f.calls.push('play'); };
  const choice = f.music.suggestions.put('guild-a', { encoded: 'audio', info: { title: 'test' } } as TrackStructure);
  await Promise.all([f.music.play(f.ctx, choice), f.music.play(f.ctx, choice)]);
  assert.equal(f.calls.filter(call => call === 'play').length, 1);
  assert.equal(f.added.length, 2);
});

test('Bun loads decorated command, panel and raw handler', () => {
  assert.ok(new PlayCommand());
  assert.deepEqual(controlRows().map(row => row.toJSON().components.length), [4, 2]);
  assert.equal(raw.data.name, 'raw');
});
