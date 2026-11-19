/**
 * Musixmatch fallback — the third path Soundy runs when LRCLIB has no verified match.
 * Uses the same public desktop-app API its `@mjba/lyrics` client talks to: an anonymous
 * user token from `token.get`, then `track.search` -> `track.subtitle.get` (LRC body).
 * Candidates pass the same strict edition matching as LRCLIB before their lines are used.
 *
 * ponytail: line-level subtitles only; richsync (word-level karaoke) is the upgrade path
 * if the panel ever renders per-word highlighting.
 */
import { setTimeout as wait } from 'node:timers/promises';
import { parseLRC } from './lrc.js';
import { DURATION_TOLERANCE_MS, MANUAL_TOLERANCE_MS, deriveQueries, editionLabels, editionMatches } from './metadata.js';
import type { LyricsLookup } from './types.js';

const ROOT = 'https://apic-desktop.musixmatch.com/ws/1.1/';
const LOOKUP_TIMEOUT_MS = 6_000;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/115.0.0.0 Safari/537.36';

type MxmTrack = { track_id?: number; track_name?: string; artist_name?: string; track_length?: number; has_subtitles?: number };
type MxmBody = { track_list?: Array<{ track?: MxmTrack }>; subtitle?: { subtitle_body?: string }; user_token?: string };

let token: string | null = null;
let requests: Promise<unknown> = Promise.resolve();
let nextRequestAt = 0;
let cooldownUntil = 0;

async function fetchAPI(action: string, params: Array<[string, string]>): Promise<{ status: number; body: MxmBody | null }> {
  const query = new URLSearchParams([...params, ['app_id', 'web-desktop-app-v1.0'], ['format', 'json']]);
  if (action !== 'token.get' && token) query.set('usertoken', token);
  const response = await fetch(`${ROOT}${action}?${query}`, {
    headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
  });
  if (response.status === 429 || response.status === 503) {
    const seconds = Number(response.headers.get('Retry-After') ?? '1');
    cooldownUntil = Date.now() + Math.max(1000, (Number.isFinite(seconds) ? seconds : 1) * 1000);
    return { status: response.status, body: null };
  }
  const data = await response.json().catch(() => null) as { message?: { header?: { status_code?: number }; body?: MxmBody } } | null;
  const status = data?.message?.header?.status_code ?? response.status;
  return { status, body: data?.message?.body ?? null };
}

/** Sequential, gap-policed calls with one automatic token refresh on 401. */
function call(action: string, params: Array<[string, string]> = []): Promise<MxmBody | null> {
  const run = requests.then(async () => {
    if (Date.now() < cooldownUntil) return null;
    const delay = nextRequestAt - Date.now();
    if (delay > 0) await wait(delay);
    try {
      if (action !== 'token.get' && !token) {
        // The endpoint occasionally answers 401 on the very first token request; one retry is the documented dance.
        let issued = await fetchAPI('token.get', [['user_language', 'en']]);
        if (issued.status === 401) issued = await fetchAPI('token.get', [['user_language', 'en']]);
        token = issued.body?.user_token ?? null;
        if (!token) return null;
      }
      let result = await fetchAPI(action, params);
      if (result.status === 401 && action !== 'token.get') {
        token = null;
        const issued = await fetchAPI('token.get', [['user_language', 'en']]);
        token = issued.body?.user_token ?? null;
        if (!token) return null;
        result = await fetchAPI(action, params);
      }
      return result.status === 200 ? result.body : null;
    } catch { return null; }
    finally { nextRequestAt = Date.now() + 250; }
  });
  requests = run.catch(() => {});
  return run;
}

export const lookupMusixmatch: LyricsLookup = async (track, manual = false) => {
  const queries = deriveQueries(track.info.title, track.info.author);
  if (track.info.isStream || !queries.length) return [];
  const length = track.info.length ?? 0;
  const tolerance = manual ? MANUAL_TOLERANCE_MS : DURATION_TOLERANCE_MS;

  for (const { artist, title } of queries) {
    const search = await call('track.search', [['q', `${title} ${artist}`], ['page_size', '5'], ['f_has_subtitle', '1']]);
    const candidates = (search?.track_list ?? [])
      .map(entry => entry?.track)
      .filter((hit): hit is MxmTrack => !!hit && Number.isFinite(hit.track_id) && !!hit.has_subtitles)
      .filter(hit => editionMatches({ title: hit.track_name, artist: hit.artist_name, durationSeconds: hit.track_length }, track, queries, tolerance));
    if (!candidates.length) continue;
    // Edition agreement first, closest length second — same rule as LRCLIB: the lyric video, studio
    // audio and music video of one song share a duration but not a timeline.
    const wanted = editionLabels(track.info.title);
    const score = (hit: MxmTrack) => {
      const have = editionLabels(hit.track_name);
      return have.filter(label => wanted.includes(label)).length * 10 - have.filter(label => !wanted.includes(label)).length;
    };
    candidates.sort((a, b) => score(b) - score(a) || (length ? Math.abs((a.track_length ?? 0) * 1000 - length) - Math.abs((b.track_length ?? 0) * 1000 - length) : 0));
    const subtitle = await call('track.subtitle.get', [['track_id', String(candidates[0]!.track_id)], ['subtitle_format', 'lrc']]);
    const lrc = subtitle?.subtitle?.subtitle_body;
    const lines = lrc ? parseLRC(lrc) : [];
    if (lines.length) return lines;
  }
  return [];
};

/** Test hook: drop the cached token and queue state between suites. */
export function resetMusixmatch() { token = null; requests = Promise.resolve(); nextRequestAt = 0; cooldownUntil = 0; }