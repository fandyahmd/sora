/**
 * Live lyrics for the music controller.
 *
 * The node's LavaLyrics plugin answers HTTP 500 for every source here, so lines come bot-side from
 * LRCLIB at track start and the sung line is derived from the player's own position, which makes the
 * feature work on any node.
 *
 * Alignment is the hard part, not fetching: one song exists on LRCLIB as a studio cut, an official
 * video with a spoken intro, a live take, and a remix, each with its own timings. The lookup derives
 * clean artist/title pairs from YouTube-shaped metadata, matches the returned title to the queried
 * one, and requires the recording's duration to agree with the audio being played. Nothing can read
 * an intro out of that data, so `/lyrics-sync` remains the manual fallback.
 *
 * Lyrics are fetched from LRCLIB (https://lrclib.net) — a free, keyless, community database. Give it a
 * contact User-Agent so its operators can reach you if your usage is heavy; that is the whole etiquette.
 */
import { setTimeout as wait } from 'node:timers/promises';

const LOOKUP_TIMEOUT_MS = 6_000;
const MAX_TIMER_MS = 2_147_483_647;
/** Duration is a filter, never proof of identical intros. Reject loose studio/video matches. */
const DURATION_TOLERANCE_MS = 3_000;
const USER_AGENT = `Sora/1.0 (+${process.env.REPOSITORY_URL ?? 'https://github.com'})`;

/** What the panel renders: the whole song as plain lines, plus the index being sung (-1 before the first). */
export type LyricsSlice = { lines: readonly string[]; index: number };
export type LyricLine = { time: number; text: string };
export type LyricsTrack = { info: { title?: string; author?: string; length?: number; isStream?: boolean } };
/** The only player surface this service touches, so it can be tested without Lavalink. */
export type LyricsPlayer = { guildId: string; position: number; lastPosition?: number; isPaused?: () => boolean; queue: { current?: LyricsTrack | null } };

/** Strip brackets, upload noise and separator tails: `X (Official Video)` -> `X`. */
function clean(value?: string) {
  return (value ?? '')
    .replace(/\([^()]*\)|\[[^\]]*\]/g, ' ')
    .replace(/\s*[|/]\s*/g, ' ')
    .replace(/\b(official|lyric|lyrics|video|audio|hd|hq|mv|m\/v|visualizer|remaster(?:ed)?|color\s?coded)\b/gi, ' ')
    .replace(/\s{2,}/g, ' ').trim();
}
/** YouTube channel handles are not artist names: `HarryStylesVEVO` -> `Harry Styles`. */
function cleanArtist(value?: string) {
  return clean(value).replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/i, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\s{2,}/g, ' ').trim();
}

/**
 * Candidate artist/title pairs, most specific first. YouTube hands back `Artist - Song (Official
 * Video)` as the title and the channel as the author, sometimes swapped, so both readings are offered.
 */
export function deriveQueries(title?: string, author?: string): Array<{ artist: string; title: string }> {
  const queries: Array<{ artist: string; title: string }> = [];
  const add = (artist: string, track: string) => {
    artist = artist.trim(); track = track.trim();
    if (artist && track && !queries.some(q => q.artist.toLowerCase() === artist.toLowerCase() && q.title.toLowerCase() === track.toLowerCase())) {
      queries.push({ artist, title: track });
    }
  };
  const channel = cleanArtist(author);
  const cleanedTitle = clean(title);
  const parts = (title ?? '').split(/\s+[-\u2013\u2014]\s+/).map(clean).filter(Boolean);
  if (parts.length >= 2) {
    // Let the upload channel disambiguate `Artist - Song` versus `Song - Artist` before
    // spending requests on both readings.
    if (channel && normalize(channel) === normalize(parts[0])) add(channel, parts[1]!);
    else if (channel && normalize(channel) === normalize(parts[1])) add(channel, parts[0]!);
    add(parts[0]!, parts[1]!);
    add(parts[1]!, parts[0]!);
    if (channel) add(channel, parts[1]!);
  } else if (channel) add(channel, cleanedTitle);
  if (!queries.length && cleanedTitle) add(channel, cleanedTitle);
  return queries;
}

/** `[mm:ss.xx] line` -> timed lines. Metadata tags are dropped, and untimed lyrics yield nothing. */
export function parseLRC(value: string): LyricLine[] {
  const lines: LyricLine[] = [];
  const offset = Number(/^\s*\[offset:([+-]?\d+)\]\s*$/im.exec(value)?.[1] ?? 0);
  if (!Number.isFinite(offset) || Math.abs(offset) > MAX_TIMER_MS) return lines;
  for (const raw of value.split('\n')) {
    const match = /^((?:\[\d+:\d{1,2}(?:\.\d+)?\])+)[ \t]*(.*)$/.exec(raw.trim());
    const text = match?.[2]?.trim();
    // Blank timestamped lines mark instrumental gaps; keep the previous sung line highlighted.
    if (!match || !text) continue;
    for (const stamp of match[1]!.matchAll(/\[(\d+):(\d{1,2}(?:\.\d+)?)\]/g)) {
      const seconds = Number(stamp[2]);
      const rawTime = (Number(stamp[1]) * 60 + seconds) * 1000;
      if (!Number.isFinite(rawTime) || rawTime > MAX_TIMER_MS || seconds >= 60) continue;
      const time = Math.max(0, Math.round(rawTime - offset));
      if (!Number.isFinite(time) || time > MAX_TIMER_MS) continue;
      lines.push({ time, text });
    }
  }
  return lines.sort((a, b) => a.time - b.time);
}

/** Index of the line being sung at `position`; -1 before the first line. */
export function indexAt(times: readonly number[], position: number) {
  let index = -1;
  while (index + 1 < times.length && times[index + 1]! <= position) index++;
  return index;
}

type Hit = { id?: number; trackName?: string; artistName?: string; syncedLyrics?: string | null; duration?: number; instrumental?: boolean };

function normalize(value?: string) {
  return (value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
function versions(value?: string) {
  return [...new Set((normalize(value).match(/\b(?:live|remix|acoustic|instrumental|karaoke|cover|sped up|speed up|slowed|nightcore|radio edit|extended)\b/g) ?? [])
    .map(version => version === 'speed up' ? 'sped up' : version))].sort().join('|');
}
function matchingHit(hit: Hit, track: LyricsTrack, queries: ReturnType<typeof deriveQueries>, tolerance = DURATION_TOLERANCE_MS) {
  if (hit.instrumental || !hit.syncedLyrics?.trim() || !Number.isFinite(hit.duration)) return false;
  if (versions(track.info.title) !== versions(hit.trackName)) return false;
  const title = normalize(clean(hit.trackName));
  const artist = normalize(cleanArtist(hit.artistName));
  if (!title || !artist || !queries.some(query => normalize(query.title) === title && normalize(query.artist) === artist)) return false;
  const length = track.info.length ?? 0;
  return length > 0 && Math.abs(hit.duration! * 1000 - length) <= tolerance;
}

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

/** Try exact metadata first, then rank validated search hits. Matching duration alone cannot
 * establish that a video intro or arrangement has the same timing as the provider's recording. */
async function lookupLyrics(track: LyricsTrack, manual = false): Promise<LyricLine[]> {
  const length = track.info.length ?? 0;
  const queries = deriveQueries(track.info.title, track.info.author);
  if (track.info.isStream || !queries.length) return [];
  const seconds = Math.round(length / 1000);

  if (seconds) {
    // The exact endpoint is preferred, but every returned hit is still checked against title, artist,
    // version qualifiers and duration before it can become the active lyrics.
    for (const { artist, title } of queries) {
      const hit = await request(`/api/get?artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(title)}&duration=${seconds}`);
      if (hit && !Array.isArray(hit) && matchingHit(hit, track, queries, manual ? 120_000 : DURATION_TOLERANCE_MS)) {
        const lines = parseLRC(hit.syncedLyrics!);
        if (lines.length) return lines;
      }
    }
  }

  const results = await Promise.all(queries.map(({ artist, title }) =>
    request(`/api/search?track_name=${encodeURIComponent(title)}&artist_name=${encodeURIComponent(artist)}`)));
  const seen = new Set<number>();
  const synced: Hit[] = [];
  for (const result of results) {
    for (const hit of Array.isArray(result) ? result : []) {
      if (!matchingHit(hit, track, queries, manual ? 120_000 : DURATION_TOLERANCE_MS)) continue;
      if (hit.id) { if (seen.has(hit.id)) continue; seen.add(hit.id); }
      synced.push(hit);
    }
  }
  // Closest length wins: a live or remixed take is the same words at the wrong times.
  if (length) synced.sort((a, b) => Math.abs((a.duration ?? 0) * 1000 - length) - Math.abs((b.duration ?? 0) * 1000 - length));
  const best = synced[0];
  if (!best?.syncedLyrics) return [];
  if (length && !manual && Math.abs((best.duration ?? 0) * 1000 - length) > DURATION_TOLERANCE_MS) return [];
  return parseLRC(best.syncedLyrics);
}

type Entry = { track: LyricsTrack; lines: string[]; times: number[]; index: number; offset: number; pausedAt?: number; timer?: ReturnType<typeof setTimeout> };

/** A boundary already due still needs a tick, so the scheduler never arms a zero-delay spin. */
const MIN_WAIT_MS = 15;
/** Initial delivery estimate for Discord edits. Network and rate-limit delays still vary. */
const LEAD_MS = 250;

export class LyricsService {
  private readonly entries = new Map<string, Entry>();

  constructor(
    // The panel writer collapses and paces repaints itself, so a changed line just asks for one.
    private readonly refresh: (guildId: string) => Promise<unknown>,
    private readonly lookup: (track: LyricsTrack, manual?: boolean) => Promise<LyricLine[]> = lookupLyrics,
  ) {}

  /** What the panel renders right now; undefined when the track has no timed lyrics yet. */
  current(guildId: string): LyricsSlice | undefined {
    const entry = this.entries.get(guildId);
    return entry && entry.lines.length ? { lines: entry.lines, index: entry.index } : undefined;
  }

  /** A new track brings new lines, so the previous ones and their pending boundary are dropped first. */
  async trackStart(player: LyricsPlayer) {
    this.forget(player.guildId);
    const track = player.queue.current;
    if (!track) return;
    const entry: Entry = { track, lines: [], times: [], index: -1, offset: 0 };
    this.entries.set(player.guildId, entry);
    const lines = await this.lookup(track).catch(() => []);
    // Identity guards stop/skip/repeat races even when Hoshimi reuses the same Track object.
    if (this.entries.get(player.guildId) !== entry || player.queue.current !== track || entry.lines.length) return;
    if (!lines.length) return;
    entry.lines = lines.map(line => line.text);
    entry.times = lines.map(line => line.time);
    entry.index = indexAt(entry.times, this.position(player, entry) - entry.offset + LEAD_MS);
    void this.touch(player.guildId);
    this.schedule(player);
  }

  /** Hoshimi 0.6.1 extrapolates position after paused playerUpdate packets too. Use its raw
   * node position while paused (also supports a paused seek), never elapsed wall-clock time. */
  private position(player: LyricsPlayer, entry: Entry) {
    if (player.isPaused?.()) return entry.pausedAt = player.lastPosition ?? entry.pausedAt ?? player.position;
    entry.pausedAt = undefined;
    return player.position;
  }

  /** Move the sung line to wherever playback is now, and re-arm for the boundary after it. */
  align(player: LyricsPlayer) {
    const entry = this.entries.get(player.guildId);
    if (!entry) return;
    if (entry.track !== player.queue.current) { this.forget(player.guildId); return; }
    const index = indexAt(entry.times, this.position(player, entry) - entry.offset + LEAD_MS);
    // No throttle on the ask: the panel writer coalesces and paces repaints, so asking now is correct.
    if (index !== entry.index) { entry.index = index; void this.touch(player.guildId); }
    this.schedule(player);
  }

  /** One timer per boundary, cancelled while paused and re-armed on resume or playerUpdate. */
  private schedule(player: LyricsPlayer) {
    const entry = this.entries.get(player.guildId);
    if (!entry) return;
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = undefined; }
    if (player.isPaused?.()) return;
    const boundary = entry.index + 1;
    const next = entry.times[boundary];
    if (next === undefined) return; // The last line is lit; there is no boundary left to wait for.
    const delay = next + entry.offset - player.position - LEAD_MS;
    if (!Number.isFinite(delay)) return;
    const timer = setTimeout(() => {
      entry.timer = undefined;
      if (this.entries.get(player.guildId) !== entry) return;
      // Recompute instead of blindly incrementing: a delayed callback may have crossed several lines.
      this.align(player);
    }, Math.min(MAX_TIMER_MS, Math.max(MIN_WAIT_MS, delay)));
    timer.unref();
    entry.timer = timer;
  }

  /** Absolute offset for this playback only. Positive delays lyrics; audio and future tracks are untouched. */
  async setOffset(player: LyricsPlayer, seconds: number) {
    if (!Number.isFinite(seconds) || Math.abs(seconds) > 120) throw new Error('Lyric offset must be between -120 and 120 seconds.');
    const entry = this.entries.get(player.guildId);
    if (!entry || entry.track !== player.queue.current) throw new Error('No synced lyrics are available for the current track.');
    if (!entry.lines.length) {
      const lines = await this.lookup(entry.track, true).catch(() => []);
      if (this.entries.get(player.guildId) !== entry || entry.track !== player.queue.current) throw new Error('The track changed. Try again.');
      if (!lines.length) throw new Error('No synced lyrics are available for the current track.');
      entry.lines = lines.map(line => line.text);
      entry.times = lines.map(line => line.time);
    }
    entry.offset = Math.round(seconds * 1000);
    this.align(player);
    return entry.offset / 1000;
  }

  /** Playback is over: drop the lines and the pending boundary. */
  forget(guildId: string) {
    const entry = this.entries.get(guildId);
    if (entry?.timer) clearTimeout(entry.timer);
    this.entries.delete(guildId);
  }

  /** A failed panel edit is not worth surfacing: the next line tries again a moment later. */
  private touch(guildId: string) {
    return Promise.resolve(this.refresh(guildId)).catch(() => {});
  }
}
