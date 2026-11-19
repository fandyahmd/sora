import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { chain, withCache, editionMatches, deriveQueries, lookupMusixmatch, type LyricLine, type LyricsTrack } from '../src/lyrics/index.js';
import { resetMusixmatch } from '../src/lyrics/musixmatch.js';

const track: LyricsTrack = { info: { title: 'Timeless', author: 'TheWeekndVEVO', length: 252_000 } };
const timed = (text: string, time: number): LyricLine => ({ time, text });

/** Fetch double: routes by URL substring, records every call, restores the real fetch afterwards. */
function stubFetch(routes: Array<{ match: string; body: unknown; status?: number }>) {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const route = routes.find(entry => url.includes(entry.match));
    if (!route) throw new Error(`unexpected fetch: ${url}`);
    return new Response(JSON.stringify(route.body), { status: route.status ?? 200 });
  }) as typeof fetch;
  return { calls, restore() { globalThis.fetch = original; } };
}

const mxm = (status: number, body: unknown) => ({ message: { header: { status_code: status }, body } });

test('edition matching rejects wrong editions and accepts the same recording', () => {
  const queries = deriveQueries(track.info.title, track.info.author);
  const base = { title: 'Timeless', artist: 'The Weeknd', durationSeconds: 252 };
  assert.equal(editionMatches(base, track, queries, 3_000), true);
  assert.equal(editionMatches({ ...base, title: 'Timeless (Live)' }, track, queries, 3_000), false); // version qualifier
  assert.equal(editionMatches({ ...base, artist: 'Someone Else' }, track, queries, 3_000), false);
  assert.equal(editionMatches({ ...base, durationSeconds: 260 }, track, queries, 3_000), false); // 8s off
  assert.equal(editionMatches({ ...base, durationSeconds: 260 }, track, queries, 120_000), true); // manual rescue
  assert.equal(editionMatches({ ...base, durationSeconds: 0 }, track, queries, 3_000), true); // provider lacks duration: metadata still matched
});

test('musixmatch issues a token once, searches, and parses the LRC subtitle body', async () => {
  resetMusixmatch();
  const stub = stubFetch([
    { match: 'token.get', body: mxm(200, { user_token: 'tok-1' }) },
    { match: 'track.search', body: mxm(200, { track_list: [{ track: { track_id: 7, track_name: 'Timeless', artist_name: 'The Weeknd', track_length: 252, has_subtitles: 1 } }] }) },
    { match: 'track.subtitle.get', body: mxm(200, { subtitle: { subtitle_body: '[00:05.50] first line\n[00:12.00] second line' } }) },
  ]);
  try {
    const lines = await lookupMusixmatch(track);
    assert.deepEqual(lines, [timed('first line', 5_500), timed('second line', 12_000)]);
    assert.equal(stub.calls.filter(url => url.includes('token.get')).length, 1);
    assert.ok(stub.calls.some(url => url.includes('track.subtitle.get') && url.includes('track_id=7') && url.includes('usertoken=tok-1')));
    // A second lookup reuses the in-memory token: no new token.get.
    await lookupMusixmatch({ info: { ...track.info, title: 'Timeless' } });
    assert.equal(stub.calls.filter(url => url.includes('token.get')).length, 1);
  } finally { stub.restore(); resetMusixmatch(); }
});

test('musixmatch refreshes the token once on a 401 and retries the request', async () => {
  resetMusixmatch();
  let subtitleCalls = 0;
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const body = url.includes('token.get') ? mxm(200, { user_token: url.includes('usertoken') ? 'tok-2' : 'tok-1' })
      : url.includes('track.search') ? mxm(200, { track_list: [{ track: { track_id: 9, track_name: 'Timeless', artist_name: 'The Weeknd', track_length: 252, has_subtitles: 1 } }] })
      : ++subtitleCalls === 1 ? mxm(401, {})
      : mxm(200, { subtitle: { subtitle_body: '[00:01.00] retried line' } });
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  try {
    const lines = await lookupMusixmatch(track);
    assert.deepEqual(lines, [timed('retried line', 1_000)]);
    assert.equal(subtitleCalls, 2);
    assert.equal(calls.filter(url => url.includes('token.get')).length, 2); // initial + refresh
  } finally { globalThis.fetch = original; resetMusixmatch(); }
});

test('musixmatch rejects candidates whose edition does not match the playing track', async () => {
  resetMusixmatch();
  const stub = stubFetch([
    { match: 'token.get', body: mxm(200, { user_token: 'tok-1' }) },
    { match: 'track.search', body: mxm(200, { track_list: [
      { track: { track_id: 1, track_name: 'Timeless (Live)', artist_name: 'The Weeknd', track_length: 252, has_subtitles: 1 } },
      { track: { track_id: 2, track_name: 'Timeless', artist_name: 'Other Artist', track_length: 252, has_subtitles: 1 } },
      { track: { track_id: 3, track_name: 'Timeless', artist_name: 'The Weeknd', track_length: 400, has_subtitles: 1 } },
    ] }) },
  ]);
  try {
    assert.deepEqual(await lookupMusixmatch(track), []);
    assert.equal(stub.calls.some(url => url.includes('track.subtitle.get')), false); // never fetches lyrics for a wrong edition
  } finally { stub.restore(); resetMusixmatch(); }
});

test('the provider chain falls through to the next source only on an empty result', async () => {
  const order: string[] = [];
  const empty = async () => { order.push('lrclib'); return []; };
  const hit = async () => { order.push('musixmatch'); return [timed('line', 1_000)]; };
  const lookup = chain(empty, hit);
  assert.deepEqual(await lookup(track), [timed('line', 1_000)]);
  assert.deepEqual(order, ['lrclib', 'musixmatch']);
  // A first-source hit never touches the fallback.
  order.length = 0;
  assert.deepEqual(await chain(hit, empty)(track), [timed('line', 1_000)]);
  assert.deepEqual(order, ['musixmatch']);
  // A throwing provider is treated as an empty result, not a broken chain.
  const boom = async () => { order.push('boom'); throw new Error('down'); };
  assert.deepEqual(await chain(boom, hit)(track), [timed('line', 1_000)]);
});

test('the cache serves replays without touching providers and dedupes concurrent starts', async () => {
  let calls = 0;
  const lookup = withCache(async () => { calls++; return [timed('line', 1_000)]; });
  const [a, b] = await Promise.all([lookup(track), lookup(track)]); // two guilds, same song, one request
  assert.deepEqual(a, b);
  assert.equal(calls, 1);
  await lookup(track); // replay
  assert.equal(calls, 1);
  await lookup(track, true); // manual rescue is a different contract: not served from the auto cache
  assert.equal(calls, 2);
  await lookup({ info: { ...track.info, length: 253_000 } }); // a different recording
  assert.equal(calls, 3);
});

test('the cache evicts the oldest entry and never pins a rejection', async () => {
  let calls = 0;
  const lookup = withCache(async (t: LyricsTrack) => { calls++; return [timed(String(t.info.length), 0)]; }, 2);
  const one = { info: { title: 'A', author: 'X', length: 1 } };
  const two = { info: { title: 'B', author: 'X', length: 2 } };
  const three = { info: { title: 'C', author: 'X', length: 3 } };
  await lookup(one); await lookup(two); await lookup(three); // evicts one
  await lookup(one);
  assert.equal(calls, 4);
  let fail = true;
  const flaky = withCache(async () => { calls++; if (fail) throw new Error('provider down'); return []; });
  await assert.rejects(flaky(one));
  fail = false;
  await flaky(one); // the rejection was evicted, so this retries instead of replaying the failure
  assert.equal(calls, 6);
});