/**
 * Live lyrics for the music controller.
 *
 * The node's LavaLyrics plugin answers HTTP 500 for every source here, so lines come bot-side from
 * LRCLIB at track start and the sung line is derived from the player's own position, which makes the
 * feature work on any node.
 *
 * Alignment is the hard part, not fetching: one song exists on LRCLIB as a studio cut, an official
 * video with a spoken intro, a live take, and a remix, each with its own timings. So the lookup
 * derives clean artist/title pairs from YouTube-shaped metadata, asks LRCLIB for the exact
 * artist+title+duration first, and otherwise takes the synced version whose length is closest to the
 * Panel edits stay under Discord's ~5 edits / 5s per channel.
 *
 * Lyrics are fetched from LRCLIB (https://lrclib.net) — a free, keyless, community database. Give it a
 * contact User-Agent so its operators can reach you if your usage is heavy; that is the whole etiquette.
 */
const LOOKUP_TIMEOUT_MS = 6_000;
/** A lyric version this much longer or shorter than the audio is a different edit, not a match. */
const DURATION_TOLERANCE_MS = 15_000;
const USER_AGENT = `Sora/1.0 (+${process.env.REPOSITORY_URL ?? 'https://github.com'})`;

/** What the panel renders: the whole song as plain lines, plus the index being sung (-1 before the first). */
export type LyricsSlice = { lines: readonly string[]; index: number };
export type LyricLine = { time: number; text: string };
export type LyricsTrack = { info: { title?: string; author?: string; length?: number; isStream?: boolean } };
/** The only player surface this service touches, so it can be tested without Lavalink. */
export type LyricsPlayer = { guildId: string; position: number; queue: { current?: LyricsTrack | null } };

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
  add(channel, clean(title));
  const parts = (title ?? '').split(/\s+[-\u2013\u2014]\s+/).map(clean).filter(Boolean);
  if (parts.length >= 2) {
    add(parts[0]!, parts[1]!);                                   // Artist - Song
    add(parts[1]!, parts[0]!);                                   // Song - Artist
    if (channel) add(channel, parts[1]!);                        // Channel - Song
  }
  return queries;
}

/** `[mm:ss.xx] line` -> timed lines. Metadata tags are dropped, and untimed lyrics yield nothing. */
export function parseLRC(value: string): LyricLine[] {
  const lines: LyricLine[] = [];
  for (const raw of value.split('\n')) {
    const match = /^\[(\d+):(\d{1,2}(?:\.\d+)?)\]\s?(.*)$/.exec(raw.trim());
    // Blank lines mark instrumental gaps; dropping them keeps the last sung line lit instead of
    // putting an empty line in the spotlight, which is what a lyrics player does.
    if (match && match[3]!.trim()) lines.push({ time: (Number(match[1]) * 60 + Number(match[2])) * 1000, text: match[3]!.trim() });
  }
  return lines.sort((a, b) => a.time - b.time);
}

/** Index of the line being sung at `position`; -1 before the first line. */
export function indexAt(times: readonly number[], position: number) {
  let index = -1;
  while (index + 1 < times.length && times[index + 1]! <= position) index++;
  return index;
}

type Hit = { id?: number; syncedLyrics?: string | null; duration?: number; instrumental?: boolean };

async function request(path: string): Promise<Hit | Hit[] | null> {
  const response = await fetch(`https://lrclib.net${path}`, {
    headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
  });
  if (!response.ok) return null;
  return (await response.json().catch(() => null)) as Hit | Hit[] | null;
}

/**
 * Timed lines for a track, aligned to the audio being played. The exact artist+title+duration
 * endpoint is authoritative because it scores the version against the audio's own length; only when
 * it misses does the search widen, and those hits are ranked by length difference.
 */
async function lookupLyrics(track: LyricsTrack): Promise<LyricLine[]> {
  const length = track.info.length ?? 0;
  const queries = deriveQueries(track.info.title, track.info.author);
  if (track.info.isStream || !queries.length) return [];
  const seconds = Math.round(length / 1000);

  if (seconds) {
    // Concurrent, then picked in priority order: the extra candidate pairs must not delay the panel.
    const exact = await Promise.all(queries.map(({ artist, title }) =>
      request(`/api/get?artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(title)}&duration=${seconds}`)));
    for (const hit of exact) {
      if (hit && !Array.isArray(hit) && !hit.instrumental && hit.syncedLyrics?.trim()) return parseLRC(hit.syncedLyrics);
    }
  }

  const primary = queries[0]!;
  const results = await Promise.all([
    request(`/api/search?track_name=${encodeURIComponent(primary.title)}&artist_name=${encodeURIComponent(primary.artist)}`),
    request(`/api/search?q=${encodeURIComponent(`${clean(track.info.title)} ${clean(track.info.author)}`)}`),
  ]);
  const seen = new Set<number>();
  const synced: Hit[] = [];
  for (const result of results) {
    for (const hit of Array.isArray(result) ? result : []) {
      if (!hit.syncedLyrics?.trim() || hit.instrumental) continue;
      if (hit.id) { if (seen.has(hit.id)) continue; seen.add(hit.id); }
      synced.push(hit);
    }
  }
  // Closest length wins: a live or remixed take is the same words at the wrong times.
  if (length) synced.sort((a, b) => Math.abs((a.duration ?? 0) * 1000 - length) - Math.abs((b.duration ?? 0) * 1000 - length));
  const best = synced[0];
  if (!best?.syncedLyrics) return [];
  if (length && Math.abs((best.duration ?? 0) * 1000 - length) > DURATION_TOLERANCE_MS) return [];
  return parseLRC(best.syncedLyrics);
}

type Entry = { lines: string[]; times: number[]; index: number; timer?: ReturnType<typeof setTimeout> };

/** A boundary already due still needs a tick, so the scheduler never arms a zero-delay spin. */
const MIN_WAIT_MS = 15;
/**
 * Roughly how long a panel edit takes to land on Discord. Firing the line this much early makes it pop
 * as the singer starts rather than a round trip later. Measured round trips ran 175–300 ms.
 */
const LEAD_MS = 250;

export class LyricsService {
  private readonly entries = new Map<string, Entry>();

  constructor(
    // The panel writer collapses and paces repaints itself, so a changed line just asks for one.
    private readonly refresh: (guildId: string) => Promise<unknown>,
    private readonly lookup: (track: LyricsTrack) => Promise<LyricLine[]> = lookupLyrics,
  ) {}

  /** What the panel renders right now; undefined when the track has no timed lyrics. */
  current(guildId: string): LyricsSlice | undefined {
    const entry = this.entries.get(guildId);
    return entry ? { lines: entry.lines, index: entry.index } : undefined;
  }

  /** A new track brings new lines, so the previous ones and their pending boundary are dropped first. */
  async trackStart(player: LyricsPlayer) {
    this.forget(player.guildId);
    const track = player.queue.current;
    if (!track) return;
    const lines = await this.lookup(track).catch(() => []);
    // The track may have changed while the lookup was in flight; a schedule now would follow the wrong song.
    if (!lines.length || player.queue.current !== track) return;
    const times = lines.map(line => line.time);
    // Position is read at insert time, so joining mid-song opens on the right line and arms the next one.
    this.entries.set(player.guildId, { lines: lines.map(line => line.text), times, index: indexAt(times, player.position) });
    void this.touch(player.guildId);
    this.schedule(player);
  }

  /** Move the sung line to wherever playback is now, and re-arm for the boundary after it. */
  align(player: LyricsPlayer) {
    const entry = this.entries.get(player.guildId);
    if (!entry) return;
    const index = indexAt(entry.times, player.position);
    // No throttle on the ask: the panel writer coalesces and paces repaints, so asking now is correct.
    if (index !== entry.index) { entry.index = index; void this.touch(player.guildId); }
    this.schedule(player);
  }

  /**
   * Fire the next line slightly EARLY, by the time an edit takes to land.
   *
   * The node's position is authoritative but only reported every few seconds, so a polling ticker made
   * every line land late — precisely what "the lyrics lag the music" describes. One timer per boundary
   * removes the polling error, but the edit itself still takes a Discord round trip, so a timer fired
   * *at* the boundary still shows the line ~200 ms after the singer starts it. Firing by LEAD_MS turns
   * that into "shows up just as the line begins", which is what a lyrics player is supposed to feel
   * like. A paused player freezes the position, so the timer re-arms for the same remaining time.
   */
  private schedule(player: LyricsPlayer) {
    const entry = this.entries.get(player.guildId);
    if (!entry) return;
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = undefined; }
    const boundary = entry.index + 1;
    const next = entry.times[boundary];
    if (next === undefined) return; // The last line is lit; there is no boundary left to wait for.
    const timer = setTimeout(() => {
      entry.timer = undefined;
      // A seek or another align may already have moved past this boundary while the timer was pending.
      if (entry.index >= boundary) { this.schedule(player); return; }
      entry.index = boundary;
      void this.touch(player.guildId);
      this.schedule(player);
    }, Math.max(MIN_WAIT_MS, next - player.position - LEAD_MS));
    timer.unref();
    entry.timer = timer;
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
