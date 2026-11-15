import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MessagesMethods } from 'seyfert';
import { CARD_FLAGS, controlRows, idleCard, panelState, playerCard, queueCard } from '../src/ui/cards.js';
import { clip, displayText, duration, httpURL } from '../src/ui/text.js';
import { bannerFile } from '../src/ui/banner.js';
import { inviteURL, supportURL } from '../src/ui/theme.js';
import { FEEDBACK, editedCopy } from '../src/feedback.js';
import MusicControls from '../src/components/music.js';
import StopCommand from '../src/commands/music/stop.js';
import QueueCommand from '../src/commands/music/queue.js';

/** Serialise through the installed Seyfert pipeline, exactly like a real send. */
const json = (body: Record<string, unknown>, files?: unknown) => MessagesMethods.transformMessageBody(body as never, (files ?? (body as { files?: unknown }).files) as never, {} as never) as any;
const track = { info: { title: 'Song', author: 'Artist', length: 185000, uri: 'https://example.com/song', artworkUrl: 'https://example.com/art.png' } };
const playback = { ...track.info, paused: false, hasPrevious: false, hasNext: true, requesterId: '234567890123456789' };

test('idle card is one Components V2 container with banner, copy and deployment links', () => {
  process.env.SUPPORT_INVITE_URL = 'https://discord.gg/example';
  const body = json({ ...idleCard('123456789012345678'), files: bannerFile() });
  assert.equal(body.flags, CARD_FLAGS);
  const [card] = body.components;
  assert.equal(card.type, 17); // Container
  assert.equal(card.accent_color, 0x5865f2);
  const [gallery, copy] = card.components;
  assert.equal(gallery.items[0].media.url, 'attachment://idle-banner.png');
  // The invite is built from this deployment's own application id, never hard-coded.
  assert.equal(copy.content, `There are no songs playing right now\n[Support](${supportURL()}) | [Invite](${inviteURL('123456789012345678')})`);
  assert.match(copy.content, /client_id=123456789012345678/);
  assert.deepEqual(body.attachments, [{ id: '0', filename: 'idle-banner.png' }]);
  assert.equal(body.embeds, undefined);
  assert.equal(body.content, undefined);

  // A self-hosted copy with no support server still renders, minus the dead link.
  delete process.env.SUPPORT_INVITE_URL;
  const bare = json(idleCard());
  assert.equal(bare.components[0].components[1].content, 'There are no songs playing right now');
});

test('player card carries linked title, artwork thumbnail, controls and no leftover banner', () => {
  const body = json(playerCard(playback));
  assert.equal(body.flags, CARD_FLAGS);
  const [card] = body.components;
  assert.equal(card.accent_color, 0x5865f2);
  const [section, divider, meta, transport, utility] = card.components;
  assert.equal(section.type, 9); // Section
  assert.equal(section.accessory.type, 11); // Thumbnail
  assert.equal(section.accessory.media.url, track.info.artworkUrl);
  // A playing track announces nothing: only the title and artist, and no "Now playing" line.
  assert.equal(section.components[0].content, '## [Song](https://example.com/song)\n### Artist');
  assert.deepEqual(divider, { type: 14, divider: true, spacing: 1 });
  assert.equal(meta.content, '-# 3:05 · Requested by <@234567890123456789>');
  // Discord caps an ActionRow at 5 buttons, so playback sits on row one and the toggles on row two.
  assert.deepEqual(transport.components.map((button: any) => [button.custom_id, button.disabled, button.style]), [
    ['music:previous', true, 2], ['music:pause', false, 1], ['music:next', false, 2], ['music:stop', false, 4],
  ]);
  assert.deepEqual(utility.components.map((button: any) => [button.custom_id, button.disabled, button.style]), [
    ['music:queue', false, 2], ['music:autoplay', false, 2],
  ]);
  const enabled = json(playerCard({ ...playback, autoplay: true }));
  assert.equal(enabled.components[0].components[4].components[1].style, 3); // Green once it is on.
  assert.deepEqual(body.attachments, []); // Clears the idle banner from the previous payload.
});

test('hostile metadata cannot escape the card or break Discord limits', () => {
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:image/png,a', 'https://user:pass@example.com', 'https://example.com/\nattack', 'not a URL', 'https://example.com/' + 'x'.repeat(1000)]) assert.equal(httpURL(url), undefined);
  assert.equal(httpURL('https://example.com/a(b)'), 'https://example.com/a%28b%29');
  assert.equal(httpURL('http://example.com/a'), 'http://example.com/a');
  assert.ok(!displayText('@everyone **[click](https://evil.example)**').includes('@everyone'));
  const hostile = { info: { title: '@everyone [x](javascript:evil) **'.repeat(1000), author: '*'.repeat(10000), uri: 'javascript:evil', artworkUrl: 'data:evil', length: Infinity } };
  const body = json(playerCard({ ...hostile.info, requesterId: '@everyone', paused: false, hasPrevious: false, hasNext: false } as never));
  const [heading, divider, meta] = body.components[0].components;
  assert.equal(heading.type, 10); // TextDisplay, because a `data:` artwork URL is rejected entirely.
  assert.equal(displayText('a'.repeat(5000), 200).length, 200); // Hostile titles are clamped, not truncated by Discord.
  assert.ok(heading.content.length <= 320, `heading ${heading.content.length} must stay bounded`);
  assert.equal(divider.spacing, 1);
  assert.equal(meta.content, '-# Unknown · Requested by Unknown');
  assert.ok(!JSON.stringify(body).includes('thumbnail'));
  assert.ok(!JSON.stringify(body).includes('](javascript'), 'a rejected URL must never come back as a markdown link');

  // Markdown escaping leaks literal backslashes on Discord, so structural characters are stripped instead.
  const hostileTitle = '[click](https://evil.example) `code` *italic* __bold__ ~strike__ `|spoiler|` <@123> \\slash';
  const output = displayText(hostileTitle);
  assert.ok(!output.includes('\\'), 'a structural character must never return as a backslash');
  assert.ok(!output.includes('**'), 'markdown must be stripped, not leaked');
  assert.ok(!output.includes('](https://evil.example'), 'no dangling markdown links');
  assert.ok(!output.includes('<@'), 'mention syntax must be neutered');

  // Ordinary punctuation survives: title punctuation must not be mangled.
  assert.equal(displayText('Astronomy (Official Lyric Video)'), 'Astronomy (Official Lyric Video)');
  const queue = json(queueCard({ queue: { current: hostile, tracks: Array(100).fill({ info: { ...hostile.info, uri: 'https://example.com/' + 'a'.repeat(155) } }) } } as never));
  const text = queue.components[0].components[0].content;
  assert.ok(text.length <= 4000, `queue text ${text.length} must fit Discord's Text Display limit`);
  assert.ok(!text.includes('](javascript'), 'hostile queue URIs are never linked');
  // A long-but-honest queue still reports its real depth rather than silently dropping tracks.
  const deep = json(queueCard({ queue: { current: track, tracks: Array(100).fill(track) } } as never));
  const deepText = deep.components[0].components[0].content;
  assert.match(deepText, /Showing first 10 of 100 queued/);
  assert.ok(deepText.length <= 4000);
  assert.equal(duration(undefined), 'Unknown');
  assert.equal(duration(-1), 'Unknown');
  assert.equal(duration(Infinity), 'Unknown');
  assert.equal(duration(0, true), 'Live stream');
  assert.equal(duration(3661000), '1:01:01');
  assert.equal(clip('abc', 3), 'abc');
  assert.equal(clip('abcdef', 3), '...');
});

test('button labels follow playback state and never render an empty control', () => {
  const idle = panelState(undefined);
  assert.equal(idle.label, 'Ready to play');
  assert.deepEqual(idle.buttons.map(button => [button.id, button.disabled]), [
    ['previous', true], ['pause', true], ['next', true], ['stop', true], ['queue', false], ['autoplay', true],
  ]);
  assert.ok(idle.buttons.every(button => button.label.length > 2));
  const playing = panelState({ title: 'Song', paused: false, hasPrevious: false, hasNext: true });
  assert.equal(playing.label, 'Song — Now playing');
  assert.deepEqual(playing.buttons.map(button => [button.id, button.disabled]), [['previous', true], ['pause', false], ['next', false], ['stop', false], ['queue', false], ['autoplay', false]]);
  // Button labels strip structural characters: Discord renders labels as plain text.
  assert.equal(panelState({ title: 'Song (Official Lyric Video)', paused: false, hasPrevious: false, hasNext: true }).label, 'Song (Official Lyric Video) — Now playing');
  const paused = panelState({ title: 'Song', paused: true, hasPrevious: true, hasNext: false });
  assert.equal(paused.label, 'Song — Paused');
  assert.deepEqual(paused.buttons.map(button => [button.id, button.disabled]), [['previous', false], ['resume', false], ['next', true], ['stop', false], ['queue', false], ['autoplay', false]]);
  // Discord rejects ActionRows holding more than 5 buttons: this is the bug that broke live sends.
  const rows = controlRows();
  assert.deepEqual(rows.map(row => row.toJSON().components.length), [4, 2]);
  assert.ok(rows.every(row => row.toJSON().components.length <= 5), 'every ActionRow must stay within Discord\'s 5-button cap');
});

test('stop confirmation is public and self-destructs while other controls stay private', async () => {
  const replies: any[] = [];
  const expired: string[] = [];
  const counts = { private: 0, public: 0, controls: 0 };
  const channel = (requestChannelId: string) => ({
    guildId: 'guild', channelId: 'text', customId: 'music:stop', interaction: { message: { id: 'panel' } },
    deferReply: async (ephemeral?: boolean) => { ephemeral ? counts.private++ : counts.public++; },
    editOrReply: async (body: unknown) => { replies.push(json(body as never)); },
    fetchResponse: async () => ({ id: `msg-${replies.length}` }),
    client: {
      requestChannels: {
        store: { get: () => ({ requestChannelId, panelMessageId: 'panel' }) },
        refresh: async () => {},
        expireResponse: (guildId: string, channelId: string, messageId: string) => { expired.push(`${guildId}/${channelId}/${messageId}`); },
      },
      music: { manager: { players: new Map() }, control: async () => { counts.controls++; } },
    },
  });
  const ctx = channel('text');
  await new MusicControls().run(ctx as never);
  assert.equal(counts.public, 1); // Public, so everyone sees the player stop.
  assert.equal(counts.private, 0);
  assert.equal(counts.controls, 1);
  assert.equal(replies[0].content, FEEDBACK.stop);
  assert.deepEqual(replies[0].allowed_mentions, { parse: [] });
  assert.deepEqual(expired, ['guild/text/msg-1']);

  ctx.customId = 'music:pause';
  await new MusicControls().run(ctx as never);
  assert.equal(counts.private, 1);
  assert.equal(counts.public, 1);
  assert.equal(replies.at(-1).content, FEEDBACK.pause);

  const stopCtx = {
    guildId: 'guild', channelId: 'text',
    client: { music: { control: async () => { counts.controls++; } },
      requestChannels: { refresh: async () => {}, expireResponse: (_g: string, _c: string, id: string) => { expired.push(`slash/${id}`); } } },
    deferReply: async () => { counts.public++; },
    editOrReply: async (body: unknown) => { replies.push(json(body as never)); },
    fetchResponse: async () => ({ id: 'slash-1' }),
  };
  await new StopCommand().run(stopCtx as never);
  assert.equal(counts.controls, 3);
  assert.equal(counts.public, 2);
  assert.deepEqual(expired.at(-1), 'slash/slash-1');
  assert.equal(editedCopy('skip'), FEEDBACK.next);
});

test('Queue button is private and read-only; stale panels reject; failures stay readable', async () => {
  let active = true;
  let controls = 0;
  const replies: any[] = [];
  const ctx = {
    guildId: 'guild', channelId: 'text', customId: 'music:queue', interaction: { message: { id: 'panel' } },
    deferReply: async (privateReply: boolean) => { assert.equal(privateReply, true); },
    editOrReply: async (body: unknown) => { replies.push(json(body as never)); },
    client: {
      requestChannels: { store: { get: () => active ? { requestChannelId: 'text', panelMessageId: 'panel' } : undefined }, refresh: async () => {} },
      music: { manager: { players: new Map([['guild', { queue: { current: track, tracks: [track] } }]]) }, control: async () => { controls++; throw new Error('Join the same voice channel as Sora.'); } },
    },
  };
  const handler = new MusicControls();
  assert.ok(handler.customId.test('music:queue'));
  await handler.run(ctx as never);
  assert.match(replies[0].components[0].components[0].content, /Sora Queue/);
  assert.equal(controls, 0);
  active = false;
  await handler.run(ctx as never);
  assert.match(replies.at(-1).content, /inactive/);
  active = true;
  ctx.customId = 'music:pause';
  await handler.run(ctx as never);
  assert.equal(controls, 1);
  assert.match(replies.at(-1).content, /same voice channel/);
  await new QueueCommand().run(ctx as never);
  assert.match(replies.at(-1).components[0].components[0].content, /Sora Queue/);
  ctx.client.music.manager.players.delete('guild'); // Empty player is the one case with no queue lines.
  await new QueueCommand().run(ctx as never);
  assert.match(replies.at(-1).components[0].components[0].content, /Queue is empty/);
});
