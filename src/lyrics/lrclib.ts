/**
 * LRCLIB (https://lrclib.net) — a free, keyless, community lyrics database.
 * Give it a contact User-Agent so its operators can reach you if your usage is heavy;
 * that is the whole etiquette. Requests run sequentially with a short gap, across guilds,
 * and 429/503 answers put the whole provider on cooldown honouring Retry-After.
 */
import { setTimeout as wait } from 'node:timers/promises';
import { parseLRC } from './lrc.js';
import { DURATION_TOLERANCE_MS, MANUAL_TOLERANCE_MS, deriveQueries, editionLabels, editionMatches } from './metadata.js';
import type { LyricsLookup, LyricsTrack } from './types.js';

const LOOKUP_TIMEOUT_MS = 6_000;
const USER_AGENT = `Sora/1.0 (+${process.env.REPOSITORY_URL ?? 'https://github.com'})`;

type Hit = { id?: number; trackName?: string; artistName?: string; syncedLyrics?: string | null; duration?: number; instrumental?: boolean };

// LRCLIB asks clients to send sequential requests with a short gap, including across guilds.
let requests: Promise<unknown> = Promise.resolve();
let nextRequestAt = 0;
let cooldownUntil = 0;
function request(path: string): Promise<Hit | Hit[] | null> {
  const run = requests.then(async () => {
    if (Date.now() < cooldownUntil) return null; // Never keep searching through a provider cooldown.
    const delay = nextRequestAt - Date.now();
    if (delay > 0) await wait(delay);
    try {
      const response = await fetch(`https://lrclib.net${path}`, {
        headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
      });
      if (response.status === 429 || response.status === 503) {
        const header = response.headers.get('Retry-After') ?? '1';
        const seconds = Number(header);
        const retry = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
        const duration = Math.max(1000, Number.isFinite(retry) ? retry : 1000);
        cooldownUntil = Date.now() + duration + Math.ceil(Math.random() * duration * 0.1);
      }
      if (!response.ok) return null;
      return (await response.json().catch(() => null)) as Hit | Hit[] | null;
    } catch { return null; }
    finally { nextRequestAt = Date.now() + 250; }
  });
  requests = run.catch(() => {});
  return run;
}

function matchingHit(hit: Hit, track: LyricsTrack, queries: ReturnType<typeof deriveQueries>, tolerance: number) {
  if (hit.instrumental || !hit.syncedLyrics?.trim() || !Number.isFinite(hit.duration)) return false;
  return editionMatches({ title: hit.trackName, artist: hit.artistName, durationSeconds: hit.duration }, track, queries, tolerance);
}

/** Try exact metadata first, then rank validated search hits. Matching duration alone cannot
 * establish that a video intro or arrangement has the same timing as the provider's recording:
 * LRCLIB holds near-identical durations for the lyric video, the studio audio and the music video,
 * each with its own timeline. Candidates are ranked by edition-label agreement with the playing
 * upload first (the signal Soundy's raw-title search gets from LRCLIB's own ranking), then by
 * duration closeness. A raw-title search joins the cleaned queries so label-bearing entries surface. */
export const lookupLRCLIB: LyricsLookup = async (track, manual = false) => {
  const length = track.info.length ?? 0;
  const queries = deriveQueries(track.info.title, track.info.author);
  if (track.info.isStream || !queries.length) return [];
  const seconds = Math.round(length / 1000);
  const tolerance = manual ? MANUAL_TOLERANCE_MS : DURATION_TOLERANCE_MS;
  const wanted = editionLabels(track.info.title);
  // Label agreement dominates; a candidate carrying a foreign edition label is worse than an unlabeled one.
  const score = (hit: Hit) => {
    const have = editionLabels(hit.trackName);
    return have.filter(label => wanted.includes(label)).length * 10 - have.filter(label => !wanted.includes(label)).length;
  };
  const perfectEdition = (hit: Hit) => score(hit) >= wanted.length * 10;
  const pool: Hit[] = [];
  const seen = new Set<number>();
  const add = (hit: Hit) => {
    if (!matchingHit(hit, track, queries, tolerance)) return;
    if (hit.id) { if (seen.has(hit.id)) return; seen.add(hit.id); }
    pool.push(hit);
  };

  if (seconds) {
    // The exact endpoint is preferred, but its hit only wins outright when its edition label agrees
    // with the upload; otherwise it joins the pool and the labeled search candidates can outrank it.
    for (const { artist, title } of queries) {
      const hit = await request(`/api/get?artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(title)}&duration=${seconds}`);
      if (hit && !Array.isArray(hit) && matchingHit(hit, track, queries, tolerance)) {
        if (perfectEdition(hit)) {
          const lines = parseLRC(hit.syncedLyrics!);
          if (lines.length) return lines;
        }
        add(hit);
      }
    }
  }

  const searches = queries.map(({ artist, title }) =>
    `/api/search?track_name=${encodeURIComponent(title)}&artist_name=${encodeURIComponent(artist)}`);
  // Soundy's path: the raw upload title lets LRCLIB's text ranking surface the matching edition.
  searches.push(`/api/search?q=${encodeURIComponent(`${track.info.title ?? ''} ${track.info.author ?? ''}`.trim())}`);
  const results = await Promise.all(searches.map(request));
  for (const result of results) {
    for (const hit of Array.isArray(result) ? result : []) add(hit);
  }
  // Edition agreement first, closest length second: a live or remixed take is the same words at the wrong times.
  pool.sort((a, b) => score(b) - score(a) || (length ? Math.abs((a.duration ?? 0) * 1000 - length) - Math.abs((b.duration ?? 0) * 1000 - length) : 0));
  const best = pool[0];
  if (!best?.syncedLyrics) return [];
  if (length && !manual && Math.abs((best.duration ?? 0) * 1000 - length) > DURATION_TOLERANCE_MS) return [];
  return parseLRC(best.syncedLyrics);
};

/** Test hook: drop the queue and cooldown state so one suite cannot poison the next. */
export function resetLRCLIB() { requests = Promise.resolve(); nextRequestAt = 0; cooldownUntil = 0; }