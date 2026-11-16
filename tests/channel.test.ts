import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'bun:test';
import { MemoryStore as GuildStore } from './memory-store.js';
import { requestFromMessage } from '../src/services/requests.js';
import { RequestChannels } from '../src/services/channels.js';
import SetupChannelCommand from '../src/commands/music/setup-channel.js';
import DeleteChannelCommand from '../src/commands/music/delete-channel.js';
import { panelState } from '../src/ui/cards.js';
import { MessagesMethods } from 'seyfert';
import { added, failed } from '../src/feedback.js';

test('idle banner uploads on create, reuse and restart; playing clears files; idle returns', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sora-'));
  try {
    const store = new GuildStore(join(dir, 'sora.sqlite'));
    const payloads: any[] = [];
    const players = new Map<string, any>();
    const record = (body: any) => {
      // Exercise installed Seyfert serializer used by both messages.write and edit.
      const json = MessagesMethods.transformMessageBody(body, body.files, {} as never);
      payloads.push({ body, json });
      return { id: 'panel' };
    };
    const client = {
      guilds: { fetchSelf: async () => ({}) },
      channels: { fetch: async () => ({ guildId: 'guild-a', type: 0 }), memberPermissions: async () => ({ has: (permissions: string[]) => {
        assert.ok(permissions.includes('AttachFiles'));
        return true;
      } }) },
      messages: { write: async (_channel: string, body: any) => record(body), edit: async (_id: string, _channel: string, body: any) => record(body) },
      music: { manager: { players }, autoplay: new GuildStore(join(dir, 'sora.sqlite')) },
    };
    const channels = new RequestChannels(client as never, store);
    await channels.setup('guild-a', 'text-a');
    await channels.setup('guild-a', 'text-a');
    await new RequestChannels(client as never, new GuildStore(join(dir, 'sora.sqlite'))).restore();
    players.set('guild-a', { queue: { current: { info: { title: 'Song', artworkUrl: 'https://example.com/song.png' } }, tracks: [], history: [] }, options: {}, isPaused: () => false });
    await channels.refresh('guild-a');
    players.clear();
    await channels.refresh('guild-a');
    const banner = await readFile(new URL('../assets/idle-banner.png', import.meta.url));
    assert.equal(banner.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    for (const index of [0, 1, 2, 4]) {
      const { body, json } = payloads[index];
      assert.deepEqual(body.files[0].data, banner);
      assert.deepEqual(json.attachments, [{ id: '0', filename: 'idle-banner.png' }]);
      const [card] = json.components;
      assert.equal(card.type, 17); // Container
      assert.equal(card.components[0].items[0].media.url, 'attachment://idle-banner.png');
      assert.match(card.components[1].content, /^There are no songs playing right now/);
    }
    assert.equal(payloads[3].body.files, undefined);
    assert.deepEqual(payloads[3].json.attachments, []); // Playing drops the idle banner.
    const [playing] = payloads[3].json.components;
    assert.equal(playing.components[0].accessory.media.url, 'https://example.com/song.png');
    // Split across two rows because Discord rejects an ActionRow with more than 5 buttons.
    assert.deepEqual(playing.components.slice(3).map((row: any) => row.components.length), [4, 2]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('setup reuses stored panel, restore edits same message and rejects other guild channels', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sora-'));
  const store = new GuildStore(join(dir, 'sora.sqlite'));
  const writes: string[] = [];
  const edits: string[] = [];
  const client = {
    botId: 'bot',
    guilds: { fetchSelf: async () => ({}), channels: {
      list: async () => [], create: async () => ({ id: 'created', guildId: 'guild-a', type: 0 }),
    } },
    channels: { fetch: async (id: string) => ({ id, guildId: id === 'foreign' ? 'guild-b' : 'guild-a', type: 0 }),
      memberPermissions: async () => ({ has: () => true }) },
    messages: {
      write: async (channel: string) => { writes.push(channel); return { id: 'panel' }; },
      edit: async (id: string) => { edits.push(id); return { id }; },
    },
    music: { manager: { players: new Map() } },
  };
  const channels = new RequestChannels(client as never, store);
  await channels.setup('guild-a', 'text-a');
  await channels.setup('guild-a', 'text-a');
  await channels.restore();
  assert.deepEqual(writes, ['text-a']);
  assert.deepEqual(edits, ['panel', 'panel']);
  await assert.rejects(() => channels.setup('guild-a', 'foreign'), /this server/);
  await rm(dir, { recursive: true, force: true });
});

test('a panel that cannot be patched in place is republished instead of breaking playback', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sora-'));
  const store = new GuildStore(join(dir, 'sora.sqlite'));
  await store.set('guild-a', { requestChannelId: 'text-a', panelMessageId: 'legacy' });
  const writes: string[] = [];
  const deletes: string[] = [];
  let legacy = true;
  const client = {
    channels: { fetch: async () => ({ id: 'text-a', guildId: 'guild-a', type: 0 }), memberPermissions: async () => ({ has: () => true }) },
    guilds: { fetchSelf: async () => ({}) },
    messages: {
      write: async (channel: string) => { writes.push(channel); return { id: 'panel-2' }; },
      delete: async (id: string) => { deletes.push(id); },
      edit: async () => {
        // Discord refuses to add Components V2 to a message created without them.
        // Exactly the shape Seyfert surfaces: a string code plus Discord's detail line.
        if (legacy) throw { code: 'API_Bad Request_50035', detail: "Invalid Form Body 50035\nembeds [MESSAGE_CANNOT_USE_LEGACY_FIELDS_WITH_COMPONENTS_V2]" };
        return { id: 'legacy' };
      },
    },
    music: { manager: { players: new Map() } },
  };
  const channels = new RequestChannels(client as never, store);
  await channels.refresh('guild-a');
  assert.deepEqual(writes, ['text-a']);
  assert.deepEqual(deletes, ['legacy']);
  assert.deepEqual(store.get('guild-a'), { requestChannelId: 'text-a', panelMessageId: 'panel-2' });
  // A deleted panel is republished too, and a healthy panel is still just patched.
  legacy = false;
  await channels.refresh('guild-a');
  assert.deepEqual(writes, ['text-a']);
  await channels.refresh('missing'); // A guild with no binding is a no-op, never a crash.
  assert.deepEqual(writes, ['text-a']);
  await rm(dir, { recursive: true, force: true });
});

test('setup creates default channel and checks bot permission before writing panel', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sora-'));
  const store = new GuildStore(join(dir, 'sora.sqlite'));
  let permitted = false;
  let created = 0;
  let writes = 0;
  const client = {
    guilds: { fetchSelf: async () => ({ fetchPermissions: async () => ({ has: () => permitted }) }), channels: {
      list: async () => [], create: async (_guild: string, body: { name: string }) => {
        assert.equal(body.name, 'sora-request-song'); created++; return { id: 'default' };
      },
    } },
    channels: { fetch: async () => ({ id: 'default', guildId: 'guild-a', type: 0 }),
      memberPermissions: async () => ({ has: (permissions: string[]) => {
        assert.ok(permissions.includes('EmbedLinks'));
        assert.ok(permissions.includes('ManageMessages'));
        return permitted;
      } }) },
    messages: { write: async () => { writes++; return { id: 'panel' }; } },
    music: { manager: { players: new Map() } },
  };
  const channels = new RequestChannels(client as never, store);
  await assert.rejects(() => channels.setup('guild-a'), /Manage Channels/);
  await assert.rejects(() => channels.setup('guild-a', 'default'), /Read Message History/);
  assert.equal(created, 0);
  assert.equal(writes, 0);
  assert.equal(store.get('guild-a'), undefined);
  permitted = true;
  assert.equal(await channels.setup('guild-a'), 'default');
  assert.equal(created, 1);
  assert.equal(writes, 1);
  // Sora made this channel, so it stays marked as deletable until a member picks one instead.
  assert.deepEqual(new GuildStore(join(dir, 'sora.sqlite')).get('guild-a'), { requestChannelId: 'default', panelMessageId: 'panel', channelOwned: true });
  await rm(dir, { recursive: true, force: true });
});

test('setup rejects caller without Manage Channels even if command permission overridden', async () => {
  let setups = 0;
  const ctx = { guildId: 'guild-a', deferReply: async () => {},
    member: { fetchPermissions: async () => ({ has: () => false }) },
    client: { requestChannels: { setup: async () => { setups++; } } }, options: {},
  };
  await assert.rejects(() => new SetupChannelCommand().run(ctx as never), /Manage Channels/);
  assert.equal(setups, 0);
});


/** Client stub whose only Discord surface is the one teardown touches, plus setup to build a binding. */
type TeardownCounters = { channelDeletes: number; deletedChannelIds: string[] };
function teardownClient(deleted: Array<[string, string]>, counters: TeardownCounters, existing: Array<{ id: string; name: string; type: number }> = []) {
  return {
    channels: {
      delete: async (id: string) => { counters.channelDeletes++; counters.deletedChannelIds.push(id); },
      fetch: async (id: string) => ({ id, guildId: 'guild-a', type: 0 }),
      memberPermissions: async () => ({ has: () => true }),
    },
    guilds: { fetchSelf: async () => ({ fetchPermissions: async () => ({ has: () => true }) }),
      channels: { list: async () => existing, create: async () => ({ id: 'owned-a' }) } },
    messages: {
      write: async () => ({ id: 'panel' }),
      edit: async () => ({ id: 'panel' }),
      delete: async (id: string, channel: string) => { deleted.push([id, channel]); },
    },
    music: { manager: { players: new Map() } },
  };
}

test('delete-channel keeps a channel the member picked, and forgets the guild', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sora-'));
  const store = new GuildStore(join(dir, 'sora.sqlite'));
  const deleted: Array<[string, string]> = [];
  const counters = { channelDeletes: 0, deletedChannelIds: [] as string[] };
  const channels = new RequestChannels(teardownClient(deleted, counters) as never, store);
  await channels.setup('guild-a', 'text-a'); // Chosen by a person, so it is not Sora's to delete.
  await store.toggleAutoplay('guild-a');
  await assert.rejects(() => channels.teardown('guild-unknown'), /not set up/);
  assert.deepEqual(deleted, []);

  assert.deepEqual(await channels.teardown('guild-a'), { channelId: 'text-a', channelDeleted: false });
  assert.deepEqual(deleted, [['panel', 'text-a']]); // Only the panel message.
  assert.equal(counters.channelDeletes, 0); // The member's channel survives.
  assert.equal(store.get('guild-a'), undefined);
  assert.equal(store.has('guild-a'), false); // Autoplay setting goes with it.
  await assert.rejects(() => channels.teardown('guild-a'), /not set up/); // Second time is a clear error.
  await rm(dir, { recursive: true, force: true });
});

test('delete-channel deletes the channel Sora created itself, but never one it only adopted by name', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sora-'));

  // Sora found no channel and created one: deleting it is the whole point of the command.
  const owned = new GuildStore(join(dir, 'owned.sqlite'));
  const ownedDeleted: Array<[string, string]> = [];
  const ownedCounters = { channelDeletes: 0, deletedChannelIds: [] as string[] };
  const ownedChannels = new RequestChannels(teardownClient(ownedDeleted, ownedCounters) as never, owned);
  assert.equal(await ownedChannels.setup('guild-a'), 'owned-a');
  assert.deepEqual(await ownedChannels.teardown('guild-a'), { channelId: 'owned-a', channelDeleted: true });
  assert.deepEqual(ownedCounters.deletedChannelIds, ['owned-a']);
  assert.deepEqual(ownedDeleted, []); // The channel delete took the panel message with it.
  assert.equal(owned.get('guild-a'), undefined);

  // A pre-existing `sora-request-song` channel already belonged to the server, so it must survive.
  const adopted = new GuildStore(join(dir, 'adopted.sqlite'));
  const adoptedDeleted: Array<[string, string]> = [];
  const adoptedCounters = { channelDeletes: 0, deletedChannelIds: [] as string[] };
  const adoptedChannels = new RequestChannels(
    teardownClient(adoptedDeleted, adoptedCounters, [{ id: 'old-a', name: 'sora-request-song', type: 0 }]) as never, adopted);
  assert.equal(await adoptedChannels.setup('guild-a'), 'old-a');
  assert.deepEqual(await adoptedChannels.teardown('guild-a'), { channelId: 'old-a', channelDeleted: false });
  assert.equal(adoptedCounters.channelDeletes, 0);
  assert.deepEqual(adoptedDeleted, [['panel', 'old-a']]);
  await rm(dir, { recursive: true, force: true });
});

test('delete-channel command needs Manage Channels and refuses a server that never set up', async () => {
  const replies: string[] = [];
  let teardowns = 0;
  const ctx = (permitted: boolean, setUp: boolean) => ({
    guildId: 'guild-a', member: { fetchPermissions: async () => ({ has: () => permitted }) },
    deferReply: async () => {},
    editOrReply: async (body: { content: string }) => { replies.push(body.content); },
    client: { requestChannels: {
      // teardown is the single guard: it refuses a guild that never set up.
      teardown: async () => { if (!setUp) throw new Error('Sora is not set up in this server yet.'); teardowns++; return { channelId: 'text-a', channelDeleted: false }; } } },
  });
  await assert.rejects(() => new DeleteChannelCommand().run(ctx(false, true) as never), /Manage Channels/);
  assert.equal(teardowns, 0);
  await assert.rejects(() => new DeleteChannelCommand().run(ctx(true, false) as never), /not set up/);
  assert.equal(teardowns, 0);
  await new DeleteChannelCommand().run(ctx(true, true) as never);
  assert.equal(teardowns, 1);
  assert.match(replies[0]!, /<#text-a>/); // The channel is mentioned, not stripped away.
});

test('delete-channel says nothing about the channel it deleted, and something about the one it kept', async () => {
  const replyFor = async (channelDeleted: boolean) => {
    const replies: string[] = [];
    await new DeleteChannelCommand().run({
      guildId: 'guild-a', member: { fetchPermissions: async () => ({ has: () => true }) },
      deferReply: async () => {}, editOrReply: async (body: { content: string }) => { replies.push(body.content); },
      client: { requestChannels: { teardown: async () => ({ channelId: 'text-a', channelDeleted }) } },
    } as never);
    return replies[0]!;
  };
  // A deleted channel cannot be mentioned: the mention would render as a dead link.
  assert.doesNotMatch(await replyFor(true), /<#text-a>/);
  assert.match(await replyFor(false), /<#text-a>/);
});

test('request feedback posts a cleanable message while the panel keeps player state only', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sora-'));
  const store = new GuildStore(join(dir, 'sora.sqlite'));
  await store.set('guild-a', { requestChannelId: 'text-a', panelMessageId: 'panel' });
  const queries: string[] = [];
  const panels: Array<Record<string, any>> = [];
  const feedback: string[] = [];
  const cleaned: string[] = [];
  const timers: Array<() => Promise<void>> = [];
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((callback: () => Promise<void>, delay?: number) => {
    // Only the five-second feedback lifetime is captured; the panel's own pacing timer must run for real.
    if (delay !== 5_000) return originalSetTimeout(callback, delay);
    timers.push(callback);
    return { unref() {} } as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  try {
    const client = {
      members: { fetch: async () => ({ voice: async () => ({ channelId: 'voice-a' }) }) },
      music: { manager: { players: new Map() }, play: async (_ctx: unknown, query: string) => {
        queries.push(query);
        if (query === 'denied') throw new Error('Join a voice channel first.');
        return [{ info: { title: 'Song' } }];
      } },
      messages: {
        edit: async (id: string, channel: string, body: Record<string, any>) => {
          assert.equal(id, 'panel'); assert.equal(channel, 'text-a');
          panels.push(MessagesMethods.transformMessageBody(body, body.files, {} as never) as never);
        },
        write: async (channel: string, body: { content: string }) => {
          assert.equal(channel, 'text-a'); feedback.push(body.content); return { id: `msg-${feedback.length}` };
        },
        delete: async (id: string) => { cleaned.push(id); },
      },
    };
    const channels = new RequestChannels(client as never, store);
    const message = { guild_id: 'guild-a', channel_id: 'text-a', id: 'request', author: { id: 'user' }, content: 'song' };
    for (const ignored of [ { ...message, guild_id: 'guild-b' }, { ...message, channel_id: 'other' },
      { ...message, author: { id: 'bot', bot: true } }, { ...message, webhook_id: 'hook' } ]) {
      await channels.request(ignored as never);
    }
    assert.deepEqual(queries, []);
    assert.deepEqual(cleaned, []);
    for (const content of ['   ', 'song', 'https://example.com/song', 'denied', 'x'.repeat(501)]) {
      await channels.request({ ...message, content } as never);
    }
    assert.deepEqual(queries, ['song', 'https://example.com/song', 'denied']);
    // The user's own line is erased at once, so the reply appears to replace the text that was sent.
    assert.deepEqual(cleaned, ['request', 'request', 'request', 'request', 'request']);
    assert.deepEqual(feedback, [added('Song', 0), added('Song', 0), failed('Join a voice channel first.'), failed('Song title or URL must be 1–500 characters.')]);
    // Panel edits never carry request feedback; idle copy stays intact.
    assert.ok(panels.length > 0);
    for (const panel of panels) {
      assert.match(panel.components[0].components[1].content, /^There are no songs playing right now/);
    }
    assert.deepEqual(cleaned.slice(5), []);
    for (const timer of timers) await timer();
    assert.deepEqual(cleaned.slice(5), ['msg-1', 'msg-2', 'msg-3', 'msg-4']); // Feedback notes clean themselves up too.
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    await rm(dir, { recursive: true, force: true });
  }
});

test('request messages schedule deletion after exactly 5 seconds, including empty and invalid input', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sora-'));
  const store = new GuildStore(join(dir, 'sora.sqlite'));
  await store.set('guild-a', { requestChannelId: 'text-a', panelMessageId: 'panel' });
  const timers: Array<() => void> = [];
  const deleted: string[] = [];
  const written: string[] = [];
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((callback: () => void, delay?: number) => {
    if (delay !== 5_000) return originalSetTimeout(callback, delay);
    timers.push(callback);
    return { unref() {} } as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  try {
    const client = {
      music: { manager: { players: new Map() }, play: async () => { throw new Error('should not play'); } },
      messages: { delete: async (id: string) => { deleted.push(id); }, edit: async () => {},
        write: async (_channel: string, body: { content: string }) => { written.push(body.content); return { id: `feedback-${written.length}` }; } },
    };
    const channels = new RequestChannels(client as never, store);
    for (const [id, content] of [['empty', '   '], ['invalid', 'x'.repeat(501)]] as const) {
      await channels.request({ guild_id: 'guild-a', channel_id: 'text-a', id, author: { id: 'user' }, content } as never);
    }
    assert.deepEqual(deleted, ['empty', 'invalid']); // Erased immediately, no waiting.
    assert.deepEqual(written, [failed('Song title or URL must be 1–500 characters.')]); // Empty input gets silence, invalid input gets a reason.
    assert.equal(timers.length, 1); // Only the feedback note is on the 5 second clock.
    for (const timer of timers) timer();
    await new Promise(resolve => originalSetTimeout(resolve, 0));
    assert.deepEqual(deleted, ['empty', 'invalid', 'feedback-1']);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    await rm(dir, { recursive: true, force: true });
  }
});

test('request cleanup excludes bots, webhooks, other channels, DMs and controller; failures leave playback running', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sora-'));
  const store = new GuildStore(join(dir, 'sora.sqlite'));
  await store.set('guild-a', { requestChannelId: 'text-a', panelMessageId: 'panel' });
  const timers: Array<() => Promise<void>> = [];
  const warnings: unknown[][] = [];
  let unrefs = 0;
  let plays = 0;
  let code = 10008;
  const originalSetTimeout = globalThis.setTimeout;
  const originalWarn = console.warn;
  globalThis.setTimeout = ((callback: () => Promise<void>, delay?: number) => {
    if (delay !== 5_000) return originalSetTimeout(callback, delay);
    timers.push(callback);
    return { unref() { unrefs++; } } as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  console.warn = (...args) => { warnings.push(args); };
  try {
    const channels = new RequestChannels({
      members: { fetch: async () => ({}) },
      music: { manager: { players: new Map() }, play: async () => { plays++; return [{ info: { title: 'Song' } }]; } },
      messages: { delete: async () => { throw { code }; }, edit: async () => {},
        write: async () => ({ id: 'feedback' }) },
    } as never, store);
    const message = { guild_id: 'guild-a', channel_id: 'text-a', id: 'request', author: { id: 'user' }, content: 'song' };
    for (const ignored of [
      { ...message, guild_id: undefined }, { ...message, guild_id: 'other' },
      { ...message, channel_id: 'other' }, { ...message, author: { id: 'bot', bot: true } },
      { ...message, webhook_id: 'hook' }, { ...message, id: 'panel' },
    ]) await channels.request(ignored as never);
    assert.equal(timers.length, 0);
    assert.equal(plays, 0);
    code = 10008;
    await channels.request({ ...message, id: 'a' } as never);
    assert.deepEqual(warnings, []); // Already deleted is benign.
    code = 50013;
    for (const id of ['b', 'c']) await channels.request({ ...message, id } as never);
    assert.equal(warnings.length, 1); // Permission warnings stay bounded to one per minute.
    assert.match(String(warnings[0]![0]), /Manage Messages/);
    assert.equal(plays, 3);
    // Playback carries on even when the request line itself cannot be erased.
    const otherChannels = new RequestChannels({ messages: { delete: async () => { throw new Error('network'); }, write: async () => ({ id: 'ignored' }) } } as never, store);
    await otherChannels.request({ ...message, content: '' } as never);
    assert.equal(warnings.length, 2); // Fresh instance, so its own throttle allows one warning.
    assert.equal(timers.length, 3); // One self-destructing feedback note per played request.
    assert.equal(unrefs, 3);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    console.warn = originalWarn;
    await rm(dir, { recursive: true, force: true });
  }
});

test('expiring confirmations delete after five seconds, but only inside the request channel', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sora-'));
  const store = new GuildStore(join(dir, 'sora.sqlite'));
  await store.set('guild-a', { requestChannelId: 'text-a', panelMessageId: 'panel' });
  const timers: Array<() => void> = [];
  const deleted: string[] = [];
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((callback: () => void, delay?: number) => {
    if (delay !== 5_000) return originalSetTimeout(callback, delay);
    timers.push(callback);
    return { unref() {} } as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  try {
    const channels = new RequestChannels({ messages: { delete: async (id: string) => { deleted.push(id); } } } as never, store);
    channels.expireResponse('guild-a', 'elsewhere', 'wrong-channel');
    channels.expireResponse(undefined, 'text-a', 'direct-message');
    channels.expireResponse('guild-a', 'text-a', 'stop-1');
    assert.equal(timers.length, 1);
    for (const timer of timers) timer();
    await new Promise(resolve => originalSetTimeout(resolve, 0));
    assert.deepEqual(deleted, ['stop-1']);
    channels.expire('feedback-1', 'text-a');
    assert.equal(timers.length, 2);
    for (const timer of timers.slice(1)) timer();
    await new Promise(resolve => originalSetTimeout(resolve, 0));
    assert.deepEqual(deleted, ['stop-1', 'feedback-1']);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    await rm(dir, { recursive: true, force: true });
  }
});

test('guild setup and autoplay survive a restart in the offline fixture, and clear() forgets the guild', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sora-'));
  const path = join(dir, 'sora.sqlite');
  const store = new GuildStore(path);
  await store.set('guild-a', { requestChannelId: 'channel-a', panelMessageId: 'message-a' });
  await store.set('guild-b', { requestChannelId: 'channel-b', panelMessageId: 'message-b' });
  assert.deepEqual(store.get('guild-a'), { requestChannelId: 'channel-a', panelMessageId: 'message-a' });
  assert.deepEqual(store.entries().map(([id]) => id), ['guild-a', 'guild-b']);
  assert.equal(store.get('guild-unknown'), undefined);

  // Autoplay is off by default and flips per guild, never globally.
  assert.equal(store.has('guild-a'), false);
  assert.equal(await store.toggleAutoplay('guild-a'), true);
  assert.equal(store.has('guild-a'), true);
  assert.equal(store.has('guild-b'), false);
  assert.equal(await store.toggleAutoplay('guild-a'), false);

  const restored = new GuildStore(path);
  assert.deepEqual(restored.get('guild-a'), { requestChannelId: 'channel-a', panelMessageId: 'message-a' });
  assert.equal(restored.has('guild-a'), false);

  // Autoplay survives a restart too, and setup data is independent of it.
  await restored.toggleAutoplay('guild-b');
  const again = new GuildStore(path);
  assert.equal(again.has('guild-b'), true);
  assert.deepEqual(again.get('guild-b'), { requestChannelId: 'channel-b', panelMessageId: 'message-b' });

  // Deleting the setup drops the panel binding, and an autoplay-only row never counts as set up.
  await again.clear('guild-b');
  assert.equal(again.get('guild-b'), undefined);
  assert.equal(again.has('guild-b'), false);
  assert.equal(again.entries().length, 1);
  await again.toggleAutoplay('guild-c');
  assert.equal(again.get('guild-c'), undefined);
  assert.equal(again.has('guild-c'), true);
  await rm(dir, { recursive: true, force: true });
});

test('panel state exposes one pause or resume toggle and disables unavailable actions', () => {
  const idle = panelState(undefined);
  assert.equal(idle.label, 'Ready to play');
  assert.deepEqual(idle.buttons.map((button) => [button.id, button.disabled]), [
    ['previous', true], ['pause', true], ['next', true], ['stop', true], ['queue', false], ['autoplay', true],
  ]);
  const playing = panelState({ title: 'Song', paused: false, hasPrevious: false, hasNext: true });
  assert.equal(playing.label, 'Song — Now playing');
  assert.deepEqual(playing.buttons.map(button => [button.id, button.disabled]), [['previous', true], ['pause', false], ['next', false], ['stop', false], ['queue', false], ['autoplay', false]]);
  const paused = panelState({ title: 'Song', paused: true, hasPrevious: true, hasNext: false });
  assert.equal(paused.label, 'Song — Paused');
  assert.deepEqual(paused.buttons.map((button) => [button.id, button.disabled]), [
    ['previous', false], ['resume', false], ['next', true], ['stop', false], ['queue', false], ['autoplay', false],
  ]);
});

test('message request accepts only configured guild channel, nonbots, and bounded title or URL', () => {
  const base = { guildId: 'guild-a', channelId: 'channel-a', author: { id: 'user-a', bot: false } };
  assert.deepEqual(requestFromMessage({ ...base, content: 'lofi mix' }, 'channel-a'), 'lofi mix');
  assert.deepEqual(requestFromMessage({ ...base, content: 'https://example.com/song' }, 'channel-a'), 'https://example.com/song');
  assert.equal(requestFromMessage({ ...base, content: 'x'.repeat(501) }, 'channel-a'), undefined);
  assert.equal(requestFromMessage({ ...base, channelId: 'other', content: 'song' }, 'channel-a'), undefined);
  assert.equal(requestFromMessage({ ...base, author: { id: 'bot', bot: true }, content: 'song' }, 'channel-a'), undefined);
  assert.equal(requestFromMessage({ ...base, guildId: undefined, content: 'song' }, 'channel-a'), undefined);
});
test('a burst of refreshes collapses into a single panel edit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sora-'));
  try {
    const store = new GuildStore(join(dir, 'sora.sqlite'));
    const edits: number[] = [];
    const players = new Map<string, any>();
    const client = {
      guilds: { fetchSelf: async () => ({}) },
      channels: { fetch: async () => ({ guildId: 'guild-a', type: 0 }), memberPermissions: async () => ({ has: () => true }) },
      messages: {
        write: async () => ({ id: 'panel' }),
        edit: async () => { edits.push(Date.now()); return {}; },
      },
      music: { manager: { players }, autoplay: new GuildStore(join(dir, 'sora.sqlite')) },
    };
    const channels = new RequestChannels(client as never, store);
    await channels.setup('guild-a', 'text-a');
    players.set('guild-a', { queue: { current: { info: { title: 'Song' } }, tracks: [], history: [] }, isDestroyed: () => false, destroyed: false, isPaused: () => false });
    edits.length = 0;

    // A skip lands trackStart, playerUpdate and queueUpdate in the same tick. Discord allows this
    // message 5 edits per 5 s, and a 429 makes the HTTP layer sleep through the request, so the
    // panel must owe ONE edit here, not four.
    await Promise.all([channels.refresh('guild-a'), channels.refresh('guild-a'), channels.refresh('guild-a'), channels.refresh('guild-a')]);
    assert.equal(edits.length, 1, 'four overlapping refreshes must collapse into one edit');

    // A later refresh is free to draw again once the pacing window has passed.
    await new Promise(resolve => setTimeout(resolve, 1_200));
    await channels.refresh('guild-a');
    assert.equal(edits.length, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
