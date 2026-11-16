import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { MessagesMethods } from 'seyfert';
import { deriveQueries, indexAt, LyricsService, parseLRC, type LyricLine, type LyricsPlayer } from '../src/services/lyrics.js';
import { lyricsBlock, playerCard } from '../src/ui/cards.js';

const json = (body: Record<string, unknown>, files?: unknown) => MessagesMethods.transformMessageBody(body as never, (files ?? (body as { files?: unknown }).files) as never, {} as never) as any;
const playback = {
  title: 'Song', author: 'Artist', length: 185000, uri: 'https://example.com/song',
  artworkUrl: 'https://example.com/art.png', paused: false, hasPrevious: false, hasNext: true, requesterId: '234567890123456789',
};

/**
 * Timer double. Every timeout is captured with its delay so a test can see what the service *scheduled*
 * — the point of a boundary scheduler — and cleared by handle so `forget`/re-arm behave for real.
 */
function fakeTimers() {
  const original = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  const queued: Array<{ handle: unknown; callback: () => void; delay: number }> = [];
  globalThis.setTimeout = ((callback: () => void, delay?: number) => {
    const handle = { unref() {} };
    queued.push({ handle, callback, delay: delay ?? 0 });
    return handle as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((handle: unknown) => {
    const index = queued.findIndex(entry => entry.handle === handle);
    if (index >= 0) queued.splice(index, 1);
  }) as typeof clearTimeout;
  return {
    get queued() { return queued.length; },
    get next() { return queued[0]?.delay; },
    async drain() { const burst = queued.splice(0); for (const { callback } of burst) callback(); await Promise.resolve(); },
    restore() { Object.assign(globalThis, original); },
  };
}

/** A player double: position is the one thing the service reads, so tests move it by hand. */
function player(guildId: string, title = 'Song', position = 0): LyricsPlayer {
  return { guildId, position, queue: { current: { info: { title, author: 'Artist', length: 185000 } } } };
}
const timed = (text: string, time: number): LyricLine => ({ time, text });

test('LRC parsing keeps timed lines only, and the sung line follows the player position', () => {
  const lrc = ['[ar:Artist]', '[00:05.50] first line', '[00:07.00] ', '[00:12.00] second line', '[00:20.75] third line', 'untimed noise'].join('\n');
  // Blank lines are instrumental gaps; they are dropped so the spotlight stays on the last sung line.
  assert.deepEqual(parseLRC(lrc), [timed('first line', 5500), timed('second line', 12000), timed('third line', 20750)]);
  // Untimed lyrics are useless for a karaoke window, so they parse to nothing rather than being guessed at.
  assert.deepEqual(parseLRC('la la la\nna na na'), []);
  assert.equal(indexAt([5_500, 12_000, 20_750], 0), -1); // Nothing is sung before the first line.
  assert.equal(indexAt([5_500, 12_000, 20_750], 5_500), 0);
  assert.equal(indexAt([5_500, 12_000, 20_750], 19_999), 1);
  assert.equal(indexAt([5_500, 12_000, 20_750], 999_999), 2);
});

test('YouTube metadata is reduced to artist and title pairs LRCLIB can actually resolve', () => {
  // The node hands back the video title and the channel, which is not an artist name.
  assert.deepEqual(deriveQueries('Harry Styles - As It Was (Official Video)', 'HarryStylesVEVO'), [
    { artist: 'Harry Styles', title: 'Harry Styles - As It Was' },
    { artist: 'Harry Styles', title: 'As It Was' },
    { artist: 'As It Was', title: 'Harry Styles' },
  ]);
  // A channel-shaped author with no dash in the title still resolves through the artist-then-title pair.
  assert.deepEqual(deriveQueries('KOMANG - RAIM LAODE LYRIC OFFICIAL', 'Raim Laode'), [
    { artist: 'Raim Laode', title: 'KOMANG - RAIM LAODE' },
    { artist: 'KOMANG', title: 'RAIM LAODE' },
    { artist: 'RAIM LAODE', title: 'KOMANG' },
    { artist: 'Raim Laode', title: 'RAIM LAODE' },
  ]);
  // "Song - Artist" titles are offered both ways round; duplicates are dropped.
  assert.deepEqual(deriveQueries('Sweater Weather - The Neighbourhood', 'TheNeighbourhoodVEVO'), [
    { artist: 'The Neighbourhood', title: 'Sweater Weather - The Neighbourhood' },
    { artist: 'Sweater Weather', title: 'The Neighbourhood' },
    { artist: 'The Neighbourhood', title: 'Sweater Weather' },
    { artist: 'The Neighbourhood', title: 'The Neighbourhood' },
  ]);
  assert.deepEqual(deriveQueries(undefined, undefined), []);
});

test('a track start fetches its lyrics, and every later track replaces them', async () => {
  const timers = fakeTimers();
  try {
    const edits: string[] = [];
    const asked: string[] = [];
    const lyrics = new LyricsService(async guildId => { edits.push(guildId); }, async track => {
      asked.push(track.info.title!);
      return [timed('one', 0), timed('two', 10_000)];
    });
    await lyrics.trackStart(player('guild-a', 'Neighbourhood - Sweater Weather'));
    assert.deepEqual(asked, ['Neighbourhood - Sweater Weather']);
    assert.deepEqual(lyrics.current('guild-a'), { lines: ['one', 'two'], index: 0 });
    assert.deepEqual(edits, ['guild-a']); // The panel repaints as soon as the lines exist.
    // Exactly one boundary is armed — for the next line — instead of a polling ticker, and it fires
    // LEAD_MS early so the edit lands as the line starts rather than a round trip after it.
    assert.equal(timers.queued, 1);
    assert.equal(timers.next, 10_000 - 250);

    await lyrics.trackStart(player('guild-a', 'Creep'));
    assert.deepEqual(asked, ['Neighbourhood - Sweater Weather', 'Creep']);
    assert.equal(timers.queued, 1); // The previous track's boundary was replaced, not stacked.

    // No lyrics found simply leaves the panel lyric-free, with nothing armed.
    const deaf = new LyricsService(async () => {}, async () => []);
    await deaf.trackStart(player('guild-b'));
    assert.equal(deaf.current('guild-b'), undefined);

    // A failed lookup is not an error: playback continues without lyrics.
    const broken = new LyricsService(async () => {}, async () => { throw new Error('network down'); });
    await broken.trackStart(player('guild-c'));
    assert.equal(broken.current('guild-c'), undefined);
  } finally { timers.restore(); }
});

test('the next line is scheduled to the millisecond, and a changed line repaints at once', async () => {
  const timers = fakeTimers();
  try {
    const edits: string[] = [];
    // The panel writer coalesces and paces repaints, so the lyric service must not throttle on top of
    // it: every line change asks immediately and the timing of the ask stays in the panel's hands.
    const lyrics = new LyricsService(async guildId => { edits.push(guildId); }, async () => [timed('a', 0), timed('b', 1_000), timed('c', 2_000)]);
    const speaker = player('guild-a');
    await lyrics.trackStart(speaker);
    assert.deepEqual(edits, ['guild-a']);
    // 1000 ms away minus the lead, not a 500 ms poll: this is what stops the line landing late.
    assert.equal(timers.next, 1_000 - 250);

    // Firing the boundary lights the line it was armed for, and arms the one after it.
    speaker.position = 1_000;
    await timers.drain();
    assert.equal(lyrics.current('guild-a')!.index, 1);
    assert.deepEqual(edits, ['guild-a', 'guild-a']);
    // The next boundary is armed 1000 ms ahead minus the lead, so its edit lands on time.
    assert.equal(timers.next, 1_000 - 250);

    // An out-of-band position change (a seek) realigns and re-arms without waiting for that boundary.
    speaker.position = 1_900;
    lyrics.align(speaker);
    assert.equal(lyrics.current('guild-a')!.index, 1); // Still line b until c is due.
    speaker.position = 2_100;
    lyrics.align(speaker);
    assert.equal(lyrics.current('guild-a')!.index, 2);
    assert.deepEqual(edits, ['guild-a', 'guild-a', 'guild-a']);
    assert.equal(timers.queued, 0); // The last line is lit, so there is no boundary left to wait for.

    // An unchanged line must not ask: a realign that lands on the same line costs no edit.
    lyrics.align(speaker);
    assert.deepEqual(edits, ['guild-a', 'guild-a', 'guild-a']);

    // Seeking backwards moves the window back rather than sticking at the furthest line.
    speaker.position = 0;
    lyrics.align(speaker);
    assert.equal(lyrics.current('guild-a')!.index, 0); // Back to the first line, not stuck at the last.
    assert.equal(timers.next, 1_000 - 250); // And the next boundary is re-armed from here, lead included.

    lyrics.forget('guild-a');
    assert.equal(lyrics.current('guild-a'), undefined);
    assert.equal(timers.queued, 0); // The pending boundary goes with the track.
    lyrics.align(speaker); // A late update for a forgotten guild is ignored, not thrown.
  } finally { timers.restore(); }
});

test('the panel shows the sung line in place, stays bounded, and never lets a lyric break the card', () => {
  const body = json(playerCard(playback, { lines: ['one', 'two', 'three', 'four', 'five'], index: 2 }));
  const card = body.components[0];
  // Lyrics sit above the meta line: heading, divider, lyrics text, lyrics divider, meta, controls.
  const [lyrics, lyricsDivider, meta, transport] = card.components.slice(2);
  assert.match(meta.content, /^-# 3:05 · Requested by /);
  assert.equal(lyricsDivider.divider, true);
  const controls = transport;
  // One line before, the sung line, one after: a karaoke window rather than the whole song.
  assert.equal(lyrics.content, '-# 🎤 Lyrics\n-# two\n**three**\n-# four');
  assert.equal(controls.components[0].custom_id, 'music:previous'); // Controls stay the last row.

  // First line of a long track: the window starts at the top rather than scrolling past it.
  const opening = json(playerCard(playback, { lines: ['a', 'b', 'c', 'd'], index: 0 }));
  assert.match(opening.components[0].components[2].content, /^\-# 🎤 Lyrics\n\*\*a\*\*/);

  // A track whose lyrics did not arrive yet adds no block at all.
  assert.deepEqual(lyricsBlock(undefined), []);
  assert.deepEqual(lyricsBlock({ lines: [], index: 0 }), []);

  // Hostile lyrics lose their markdown, headings included, instead of restyling or escaping the card.
  const hostile = json(playerCard(playback, { lines: ['## **bold** [link](https://x)', '', '*'.repeat(400)], index: 0 }));
  const content = hostile.components[0].components[2].content as string;
  assert.equal(content, '-# 🎤 Lyrics\n**bold link(https://x)**\n-#  \n-# ');
});
