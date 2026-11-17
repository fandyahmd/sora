import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { MessagesMethods } from 'seyfert';
import { deriveQueries, indexAt, LyricsService, parseLRC, type LyricLine, type LyricsPlayer } from '../src/services/lyrics.js';
import { lyricsBlock, playerCard } from '../src/ui/cards.js';
import { MusicClient } from '../src/client.js';
import { MemoryStore } from './memory-store.js';

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
  return { guildId, position, isPaused: () => false, queue: { current: { info: { title, author: 'Artist', length: 185000 } } } };
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

test('LRC offset tags and repeated timestamps use the provider timing instead of being discarded', () => {
  assert.deepEqual(parseLRC('[offset:+1500]\n[00:05.00][00:25.00] chorus\n[00:45.00] outro'), [
    timed('chorus', 3_500), timed('chorus', 23_500), timed('outro', 43_500),
  ]);
  // LRC's positive tag advances lyrics; this is distinct from /lyrics-sync's positive video delay.
  assert.deepEqual(parseLRC('[offset:+1000]\n[00:00.50] opening\n[00:99.00] malformed'), [timed('opening', 0)]);
});

test('LRC rejects timestamps and offsets outside timer-safe bounds', () => {
  assert.deepEqual(parseLRC('[99999:00.00] unreachable\n[00:05.00] valid'), [timed('valid', 5_000)]);
  assert.deepEqual(parseLRC(`[${'9'.repeat(400)}:00.00] non-finite`), []);
  for (const offset of ['2147483648', '-2147483648', '9'.repeat(400), `-${'9'.repeat(400)}`]) {
    assert.deepEqual(parseLRC(`[offset:${offset}]\n[00:05.00] unsafe shift`), []);
  }
  assert.deepEqual(parseLRC('[offset:-2147483640]\n[00:01.00] shifted out of range'), []);
});

test('untrusted lyric timing cannot overflow or poison boundary timers', async () => {
  const timers = fakeTimers();
  const speaker = player('timer-limits');
  const lyrics = new LyricsService(async () => {}, async () => [timed('distant line', 2_147_483_647)]);
  try {
    await lyrics.trackStart(speaker);
    await lyrics.setOffset(speaker, 120);
    assert.equal(timers.next, 2_147_483_647, 'delay must stay within the signed 32-bit timer ceiling');
    lyrics.forget(speaker.guildId);
    for (const time of [Infinity, NaN]) {
      const invalid = new LyricsService(async () => {}, async () => [timed('invalid line', time)]);
      await invalid.trackStart(speaker);
      assert.equal(timers.queued, 0, 'non-finite timing must not arm a timer');
      invalid.forget(speaker.guildId);
    }
  } finally { lyrics.forget(speaker.guildId); timers.restore(); }
});

test('YouTube metadata is reduced to artist and title pairs LRCLIB can actually resolve', () => {
  // The channel disambiguates Artist - Song vs Song - Artist, and the canonical pair comes first.
  assert.deepEqual(deriveQueries('Harry Styles - As It Was (Official Video)', 'HarryStylesVEVO'), [
    { artist: 'Harry Styles', title: 'As It Was' },
    { artist: 'As It Was', title: 'Harry Styles' },
  ]);
  // A channel-shaped author with no dash in the title still resolves through the artist-then-title pair.
  assert.deepEqual(deriveQueries('KOMANG - RAIM LAODE LYRIC OFFICIAL', 'Raim Laode'), [
    { artist: 'Raim Laode', title: 'KOMANG' },
    { artist: 'KOMANG', title: 'RAIM LAODE' },
    { artist: 'Raim Laode', title: 'RAIM LAODE' },
  ]);
  // "Song - Artist" titles are offered both ways round; duplicates are dropped.
  assert.deepEqual(deriveQueries('Sweater Weather - The Neighbourhood', 'TheNeighbourhoodVEVO'), [
    { artist: 'The Neighbourhood', title: 'Sweater Weather' },
    { artist: 'Sweater Weather', title: 'The Neighbourhood' },
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
    speaker.position = 1_700;
    lyrics.align(speaker);
    assert.equal(lyrics.current('guild-a')!.index, 1); // c is still beyond the 250 ms delivery lead.
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

test('pausing playback freezes the lyric line and cancels the next boundary', async () => {
  const timers = fakeTimers();
  try {
    const speaker = { ...player('pause'), paused: false, isPaused() { return this.paused; } };
    const lyrics = new LyricsService(async () => {}, async () => [timed('a', 0), timed('b', 1_000), timed('c', 2_000)]);
    await lyrics.trackStart(speaker);
    speaker.position = 400;
    speaker.paused = true;
    lyrics.align(speaker);
    assert.equal(timers.queued, 0, 'a paused player must not advance lyrics on a wall-clock timer');
    await timers.drain();
    assert.equal(lyrics.current('pause')!.index, 0);
    speaker.paused = false;
    lyrics.align(speaker);
    assert.equal(timers.next, 350);
    lyrics.forget('pause');
  } finally { timers.restore(); }
});

test('a cancelled lookup cannot restore lyrics after playback has stopped', async () => {
  const timers = fakeTimers();
  try {
    let resolve!: (lines: LyricLine[]) => void;
    const lyrics = new LyricsService(async () => {}, () => new Promise(done => { resolve = done; }));
    const loading = lyrics.trackStart(player('stopped'));
    lyrics.forget('stopped');
    resolve([timed('stale', 0), timed('line', 1_000)]);
    await loading;
    assert.equal(lyrics.current('stopped'), undefined, 'stopping during lookup must invalidate the in-flight response');
    assert.equal(timers.queued, 0);
  } finally { timers.restore(); }
});

test('a late timer uses the actual playback position rather than advancing one stale line', async () => {
  const timers = fakeTimers();
  try {
    const speaker = player('late');
    const lyrics = new LyricsService(async () => {}, async () => [timed('a', 0), timed('b', 1_000), timed('c', 2_000)]);
    await lyrics.trackStart(speaker);
    speaker.position = 2_400;
    await timers.drain();
    assert.equal(lyrics.current('late')!.index, 2, 'an event-loop delay must catch up in one edit');
    assert.equal(timers.queued, 0);
  } finally { timers.restore(); }
});

test('a timer highlights early by the Discord lead and player updates do not rewind it', async () => {
  const timers = fakeTimers();
  try {
    const speaker = player('lead');
    const lyrics = new LyricsService(async () => {}, async () => [timed('a', 0), timed('b', 1_000), timed('c', 2_000)]);
    await lyrics.trackStart(speaker);
    speaker.position = 750;
    await timers.drain();
    assert.equal(lyrics.current('lead')!.index, 1, 'the highlight is sent 250 ms early to cover the message round trip');
    lyrics.align(speaker);
    assert.equal(lyrics.current('lead')!.index, 1, 'playerUpdate must use the same clock as the timer');
    assert.equal(timers.next, 1_000);
    lyrics.forget('lead');
  } finally { timers.restore(); }
});

test('lookup rejects a wrong recording even when its duration matches exactly', async () => {
  const original = globalThis.fetch;
  try {
    const wrong = { id: 1, trackName: 'Another Song', artistName: 'Other Artist', duration: 185, syncedLyrics: '[00:01.00] wrong recording' };
    const right = { id: 2, trackName: 'Song', artistName: 'Artist', duration: 184, syncedLyrics: '[00:06.00] correct recording' };
    globalThis.fetch = (async input => Response.json(String(input).includes('/api/get?') ? wrong : [wrong, right])) as typeof fetch;
    const lyrics = new LyricsService(async () => {});
    await lyrics.trackStart(player('matched'));
    assert.deepEqual(lyrics.current('matched'), { lines: ['correct recording'], index: -1 });
    lyrics.forget('matched');
  } finally { globalThis.fetch = original; }
});

test('lookup keeps live, remix and acoustic recording qualifiers when choosing synced lyrics', async () => {
  const original = globalThis.fetch;
  try {
    const studio = { id: 1, trackName: 'Song', artistName: 'Artist', duration: 185, syncedLyrics: '[00:01.00] studio timing' };
    const live = { id: 2, trackName: 'Song (Live)', artistName: 'Artist', duration: 184, syncedLyrics: '[00:08.00] live timing' };
    globalThis.fetch = (async input => Response.json(String(input).includes('/api/get?') ? studio : [studio, live])) as typeof fetch;
    const lyrics = new LyricsService(async () => {});
    await lyrics.trackStart(player('live', 'Artist - Song (Live)'));
    assert.deepEqual(lyrics.current('live'), { lines: ['live timing'], index: -1 });
    lyrics.forget('live');
  } finally { globalThis.fetch = original; }
});

test('lookup rejects a studio cut with a ten-second duration gap instead of guessing its intro', async () => {
  const original = globalThis.fetch;
  try {
    const studio = { id: 1, trackName: 'Song', artistName: 'Artist', duration: 175, syncedLyrics: '[00:01.00] studio timing' };
    globalThis.fetch = (async input => Response.json(String(input).includes('/api/get?') ? studio : [studio])) as typeof fetch;
    const lyrics = new LyricsService(async () => {});
    await lyrics.trackStart(player('intro'));
    assert.equal(lyrics.current('intro'), undefined, 'extra duration could be intro, outro, or another arrangement');
    lyrics.forget('intro');
  } finally { globalThis.fetch = original; }
});

test('a song-specific offset delays lyrics without seeking audio or leaking to the next track', async () => {
  const timers = fakeTimers();
  try {
    const speaker = player('offset');
    const lyrics = new LyricsService(async () => {}, async () => [timed('a', 1_000), timed('b', 5_000)]);
    await lyrics.trackStart(speaker);
    assert.equal(await lyrics.setOffset(speaker, 3), 3);
    assert.equal(speaker.position, 0);
    assert.equal(timers.next, 3_750, 'a 3s video intro delays the lyric clock by 3s');
    speaker.position = 4_750;
    lyrics.align(speaker);
    assert.equal(lyrics.current('offset')!.index, 0);
    assert.equal(await lyrics.setOffset(speaker, -2), -2);
    assert.equal(lyrics.current('offset')!.index, 1, 'negative offsets advance lyrics');
    await assert.rejects(() => lyrics.setOffset(speaker, NaN), /between/);
    await assert.rejects(() => lyrics.setOffset(speaker, 121), /between/);
    speaker.position = 0;
    await lyrics.trackStart(speaker);
    assert.equal(timers.next, 750, 'starting again resets the previous offset');
    assert.equal(await lyrics.setOffset(speaker, 0), 0, 'zero restores the original timing');
    lyrics.forget('offset');
    await assert.rejects(() => lyrics.setOffset(speaker, 1), /No synced lyrics/);
  } finally { timers.restore(); }
});

test('paused player updates cannot move lyrics even when the library position getter keeps counting', async () => {
  const timers = fakeTimers();
  try {
    const speaker = { ...player('paused-update'), paused: false, isPaused() { return this.paused; } };
    const lyrics = new LyricsService(async () => {}, async () => [timed('a', 0), timed('b', 1_000)]);
    await lyrics.trackStart(speaker);
    speaker.paused = true;
    lyrics.align(speaker);
    speaker.position = 10_000;
    lyrics.align(speaker);
    assert.equal(lyrics.current('paused-update')!.index, 0);
    assert.equal(timers.queued, 0);
    lyrics.forget('paused-update');
  } finally { timers.restore(); }
});

test('Hoshimi position, pause and resume events realign lyrics and trackStart repaints before lookup', async () => {
  const client = new MusicClient({ host: 'localhost', port: 2333, password: 'unused' }, new MemoryStore() as never);
  const speaker = player('events');
  const aligned: unknown[] = [];
  let refreshes = 0;
  let resolve!: () => void;
  client.requestChannels.lyrics.align = value => { aligned.push(value); };
  client.requestChannels.refresh = async () => { refreshes++; };
  client.requestChannels.lyrics.trackStart = async () => new Promise<void>(done => { resolve = done; });
  const manager = client.music.manager;
  manager.emit('playerUpdate', speaker as never, {} as never, {} as never);
  manager.emit('playerPaused', speaker as never, null);
  manager.emit('playerResumed', speaker as never, null);
  assert.equal(aligned.length, 3);
  const before = refreshes;
  manager.emit('trackStart', speaker as never, null, {} as never);
  assert.ok(refreshes > before, 'track title must update immediately, not after a network lookup');
  resolve();
  await Promise.resolve();
});

test('an explicit video offset can load the matching studio lyrics rejected by automatic duration checks', async () => {
  const original = globalThis.fetch;
  try {
    const studio = { id: 1, trackName: 'Song', artistName: 'Artist', duration: 175, syncedLyrics: '[00:01.00] studio timing' };
    globalThis.fetch = (async input => Response.json(String(input).includes('/api/get?') ? studio : [studio])) as typeof fetch;
    const lyrics = new LyricsService(async () => {});
    const speaker = player('video-offset');
    await lyrics.trackStart(speaker);
    assert.equal(lyrics.current('video-offset'), undefined);
    await lyrics.setOffset(speaker, 10);
    assert.deepEqual(lyrics.current('video-offset'), { lines: ['studio timing'], index: -1 });
    speaker.position = 10_750;
    lyrics.align(speaker);
    assert.equal(lyrics.current('video-offset')!.index, 0);
    lyrics.forget('video-offset');
  } finally { globalThis.fetch = original; }
});

test('fallback searches clean artist/song pairs instead of repeating the YouTube upload title', async () => {
  const original = globalThis.fetch;
  try {
    const hit = { id: 1, trackName: 'Komang', artistName: 'Raim Laode', duration: 239, syncedLyrics: '[00:16.59] matched version' };
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = new URL(String(input));
      return Response.json(url.pathname === '/api/search' && url.searchParams.get('track_name') === 'KOMANG'
        && url.searchParams.get('artist_name')?.toLowerCase() === 'raim laode' ? [hit] : []);
    }) as unknown as typeof fetch;
    const lyrics = new LyricsService(async () => {});
    const speaker = player('clean-query', 'KOMANG - RAIM LAODE LYRIC OFFICIAL');
    speaker.queue.current!.info.author = 'Raim Laode';
    speaker.queue.current!.info.length = 239_000;
    await lyrics.trackStart(speaker);
    assert.deepEqual(lyrics.current('clean-query'), { lines: ['matched version'], index: -1 });
    lyrics.forget('clean-query');
  } finally { globalThis.fetch = original; }
});

test('a failed candidate lookup does not discard another successful exact result', async () => {
  const original = globalThis.fetch;
  try {
    const hit = { trackName: 'Song', artistName: 'Artist', duration: 185, syncedLyrics: '[00:04.00] found' };
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      const url = new URL(String(input));
      if (url.searchParams.get('track_name') !== 'Song') throw new Error('candidate timed out');
      return Response.json(hit);
    }) as unknown as typeof fetch;
    const lyrics = new LyricsService(async () => {});
    await lyrics.trackStart(player('partial', 'Artist - Song'));
    assert.deepEqual(lyrics.current('partial'), { lines: ['found'], index: -1 });
    lyrics.forget('partial');
  } finally { globalThis.fetch = original; }
});

test('a late automatic lookup cannot overwrite a manual lyric selection', async () => {
  const timers = fakeTimers();
  try {
    let resolve!: (lines: LyricLine[]) => void;
    const lyrics = new LyricsService(async () => {}, (_track, manual) => manual
      ? Promise.resolve([timed('manual version', 1_000)])
      : new Promise(done => { resolve = done; }));
    const speaker = player('manual-first');
    const loading = lyrics.trackStart(speaker);
    await lyrics.setOffset(speaker, 3);
    resolve([timed('old result', 500)]);
    await loading;
    assert.deepEqual(lyrics.current('manual-first'), { lines: ['manual version'], index: -1 });
    assert.equal(timers.next, 3_750);
    lyrics.forget('manual-first');
  } finally { timers.restore(); }
});

test('paused node updates keep Hoshimi clock frozen so resume cannot count paused wall time', () => {
  const client = new MusicClient({ host: 'localhost', port: 2333, password: 'unused' }, new MemoryStore() as never);
  const speaker = { ...player('frozen'), lastPosition: 400, lastPositionUpdate: Date.now(), isPaused: () => true };
  client.music.manager.emit('playerUpdate', speaker as never, {} as never, {} as never);
  assert.equal(speaker.lastPositionUpdate, null, 'Hoshimi resume reads its calculated position, so the paused anchor must not tick');
});

test('LRCLIB lookups stay sequential even when two guilds start tracks together', async () => {
  const original = globalThis.fetch;
  let active = 0;
  let peak = 0;
  try {
    globalThis.fetch = (async () => {
      peak = Math.max(peak, ++active);
      await Promise.resolve();
      active--;
      return Response.json([]);
    }) as unknown as typeof fetch;
    const lyrics = new LyricsService(async () => {});
    await Promise.all([
      lyrics.trackStart(player('network-a', 'Artist - Song')),
      lyrics.trackStart(player('network-b', 'Artist - Song')),
    ]);
    assert.equal(peak, 1, 'one process must not burst concurrent requests at LRCLIB');
    lyrics.forget('network-a');
    lyrics.forget('network-b');
  } finally { globalThis.fetch = original; }
});

test('LRCLIB Retry-After stops fallbacks and new lookups until the cooldown expires', async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let now = originalNow() + 10_000;
  let requests = 0;
  const lyrics = new LyricsService(async () => {});
  try {
    Date.now = () => now;
    globalThis.fetch = (async () => {
      requests++;
      return new Response('', { status: requests === 1 ? 429 : 503, headers: { 'Retry-After': '2' } });
    }) as unknown as typeof fetch;
    await lyrics.trackStart(player('cooldown-a', 'Artist - Song'));
    assert.equal(requests, 1, '429 stops the remaining exact and fallback requests');
    now += 1_500;
    await lyrics.trackStart(player('cooldown-b', 'Artist - Song'));
    assert.equal(requests, 1, 'new lookups also respect the shared cooldown');
    now += 1_500;
    await lyrics.trackStart(player('cooldown-c', 'Artist - Song'));
    assert.equal(requests, 2, 'requests resume only after Retry-After and jitter');
    await lyrics.trackStart(player('cooldown-d', 'Artist - Song'));
    assert.equal(requests, 2, '503 applies the same cooldown');
  } finally {
    for (const guild of ['cooldown-a', 'cooldown-b', 'cooldown-c', 'cooldown-d']) lyrics.forget(guild);
    Date.now = originalNow;
    globalThis.fetch = originalFetch;
  }
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

/** A player whose node exposes a lyrics plugin, the way Hoshimi presents `player.lyrics`. */
function pushedPlayer(guildId: string, lines: Array<{ timestamp: number; line: string }>, counters = { subscribes: 0, unsubscribes: 0 }): LyricsPlayer {
  return {
    ...player(guildId),
    lyrics: {
      subscribe: async () => { counters.subscribes++; },
      unsubscribe: async () => { counters.unsubscribes++; },
      current: async () => ({ provider: 'LavaLyrics', lines }),
    },
  };
}

test('a node lyrics plugin drives the highlight from pushed lines instead of boundary timers', async () => {
  const timers = fakeTimers();
  try {
    const edits: string[] = [];
    const counters = { subscribes: 0, unsubscribes: 0 };
    const speaker = pushedPlayer('guild-push', [
      { timestamp: 0, line: 'one' }, { timestamp: 1_000, line: 'two' }, { timestamp: 2_000, line: 'three' },
    ], counters);
    const lyrics = new LyricsService(async (guildId, urgent) => { edits.push(`${guildId}:${String(urgent)}`); });
    await lyrics.trackStart(speaker);
    assert.equal(counters.subscribes, 1);
    assert.deepEqual(lyrics.current('guild-push'), { lines: ['one', 'two', 'three'], index: 0 });
    assert.equal(timers.queued, 0, 'the node owns the boundary; no timer is armed');
    lyrics.ingest('guild-push', { lineIndex: 1, skipped: false });
    assert.equal(lyrics.current('guild-push')!.index, 1);
    assert.equal(edits.at(-1), 'guild-push:true', 'a line change skips the panel refill wait');
    lyrics.ingest('guild-push', { lineIndex: 2, skipped: true }); // seek correction keeps the node index
    assert.equal(lyrics.current('guild-push')!.index, 2);
    lyrics.stop(speaker);
    assert.equal(counters.unsubscribes, 1, 'a finished player releases its node subscription');
  } finally { timers.restore(); }
});

test('a node without a working lyrics plugin falls back to LRCLIB timing and is asked only once', async () => {
  const timers = fakeTimers();
  try {
    const lookups: string[] = [];
    let subscribes = 0;
    const lyrics = new LyricsService(async () => {}, async track => {
      lookups.push(track.info.title!);
      return [timed('a', 0), timed('b', 1_000)];
    });
    const speaker = (title: string): LyricsPlayer => ({
      ...player('guild-fallback', title),
      lyrics: { subscribe: async () => { subscribes++; throw new Error('API_Internal Server Error_500'); }, unsubscribe: async () => {}, current: async () => null },
    });
    await lyrics.trackStart(speaker('First'));
    assert.deepEqual(lyrics.current('guild-fallback'), { lines: ['a', 'b'], index: 0 });
    assert.equal(timers.next, 1_000 - 250, 'a client-side boundary timer is armed instead');
    await lyrics.trackStart(speaker('Second'));
    assert.equal(subscribes, 1, 'the dead plugin endpoint is not retried on every track');
    assert.deepEqual(lookups, ['First', 'Second']);
  } finally { timers.restore(); }
});

test('push mode honours /lyrics-sync: delayed lines wait, early lines leap ahead', async () => {
  const timers = fakeTimers();
  try {
    const speaker = pushedPlayer('guild-offset', [
      { timestamp: 0, line: 'one' }, { timestamp: 1_000, line: 'two' }, { timestamp: 2_000, line: 'three' },
    ]);
    const lyrics = new LyricsService(async () => {});
    await lyrics.trackStart(speaker);
    await lyrics.setOffset(speaker, 2); // +2 s: the pushed line is held back by exactly that much
    assert.equal(lyrics.current('guild-offset')!.index, -1);
    lyrics.ingest('guild-offset', { lineIndex: 1, skipped: false });
    assert.equal(timers.next, 2_000, 'the new line is held for the offset');
    await timers.drain();
    assert.equal(lyrics.current('guild-offset')!.index, 1);
    await lyrics.setOffset(speaker, -1.5); // -1.5 s: use the plugin's own timestamps to show a line early
    lyrics.ingest('guild-offset', { lineIndex: 0, skipped: false });
    assert.equal(lyrics.current('guild-offset')!.index, 1, 'the highlight runs ahead of the pushed index');
  } finally { timers.restore(); }
});
