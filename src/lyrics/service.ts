/**
 * Live lyrics for the music controller.
 *
 * Two clocks, best first. A node that runs a lyrics plugin (LavaLyrics, java-lyrics, lavasrc) pushes
 * a `LyricsLine` event as each line starts, so the highlight follows the node's own playback clock —
 * the mechanism Soundy uses, and the reason its lines never drift. When the plugin is missing or
 * erroring (every route answers 5xx), lines come bot-side from the provider chain at track start and
 * the sung line is derived from the player's own position, which keeps the feature working on any node.
 *
 * Fetching and matching live in ./lrclib and ./musixmatch; this file owns only the clock: entry
 * lifecycle, boundary timers, push events, pause/seek alignment and the manual /lyrics-sync offset.
 */
import { indexAt, MAX_TIMER_MS } from './lrc.js';
import { lookupLyrics } from './lookup.js';
import type { LyricLine, LyricsLookup, LyricsNode, LyricsPlayer, LyricsSlice, LyricsTrack } from './types.js';

type Entry = { track: LyricsTrack; lines: string[]; times: number[]; index: number; offset: number; mode: 'timer' | 'push'; pausedAt?: number; timer?: ReturnType<typeof setTimeout>; pending?: ReturnType<typeof setTimeout> };

/** A boundary already due still needs a tick, so the scheduler never arms a zero-delay spin. */
const MIN_WAIT_MS = 15;
/** Initial delivery estimate for Discord edits. Network and rate-limit delays still vary. */
const LEAD_MS = 250;

export class LyricsService {
  private readonly entries = new Map<string, Entry>();
  /** Guilds whose player is subscribed to node-pushed lines. */
  private readonly subscribed = new Set<string>();
  /** One latch: a node without a working lyrics plugin must not cost a subscribe attempt per track. */
  private pushUnavailable = false;

  constructor(
    // The panel writer collapses and paces repaints itself, so a changed line just asks for one.
    private readonly refresh: (guildId: string, urgent?: boolean) => Promise<unknown>,
    private readonly lookup: LyricsLookup = lookupLyrics,
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
    const entry: Entry = { track, lines: [], times: [], index: -1, offset: 0, mode: 'timer' };
    this.entries.set(player.guildId, entry);
    // Staying synchronous when the node cannot push keeps the provider request starting in this tick.
    const push = this.startPush(player, entry);
    if (push !== false && await push) return;
    const lines = await this.lookup(track).catch(() => [] as LyricLine[]);
    // Identity guards stop/skip/repeat races even when Hoshimi reuses the same Track object.
    if (this.entries.get(player.guildId) !== entry || player.queue.current !== track || entry.lines.length) return;
    if (!lines.length) return;
    entry.lines = lines.map(line => line.text);
    entry.times = lines.map(line => line.time);
    entry.index = indexAt(entry.times, this.position(player, entry) - entry.offset + LEAD_MS);
    void this.touch(player.guildId);
    this.schedule(player);
  }

  /**
   * Preferred clock: ask the node for its lyrics and let `LyricsLine` events move the highlight.
   * Returns false when the node has no working plugin or no lyrics for this track, so the caller
   * falls back to bot-side timing without losing the panel.
   */
  private startPush(player: LyricsPlayer, entry: Entry): Promise<boolean> | false {
    const lyrics = player.lyrics;
    if (!lyrics || this.pushUnavailable) return false;
    return this.pushLyrics(player, entry, lyrics);
  }

  private async pushLyrics(player: LyricsPlayer, entry: Entry, lyrics: LyricsNode): Promise<boolean> {
    if (!this.subscribed.has(player.guildId)) {
      const failure = await lyrics.subscribe().then(() => null, (error: unknown) => error);
      if (failure) {
        // A node whose plugin is missing or erroring answers every lyrics route with 5xx. Latch so
        // a dead plugin costs one request ever, not one per track.
        this.pushUnavailable = true;
        console.warn('Lyrics plugin unavailable on the node; live lines fall back to bot-side timing.');
        return false;
      }
      this.subscribed.add(player.guildId);
    }
    const result = await lyrics.current().catch(() => null);
    const lines = (result?.lines ?? [])
      .filter(line => Number.isFinite(line?.timestamp) && typeof line?.line === 'string' && line.line.trim())
      .sort((a, b) => a.timestamp - b.timestamp);
    if (!lines.length) return false; // Subscribed but silent: the provider chain may still know this track.
    // Identity guards stop/skip/repeat races even when Hoshimi reuses the same Track object.
    if (this.entries.get(player.guildId) !== entry || player.queue.current !== entry.track) return false;
    entry.mode = 'push';
    entry.lines = lines.map(line => line.line.trim());
    entry.times = lines.map(line => Math.max(0, Math.round(line.timestamp)));
    entry.index = indexAt(entry.times, this.position(player, entry));
    void this.touch(player.guildId, true);
    return true;
  }

  /** A node-pushed line. `skipped` events are seeks: apply the index at once, offsets and all. */
  ingest(guildId: string, payload: { lineIndex: number; skipped?: boolean }) {
    const entry = this.entries.get(guildId);
    if (!entry || entry.mode !== 'push') return;
    if (entry.pending) { clearTimeout(entry.pending); entry.pending = undefined; }
    const index = Math.max(0, Math.min(entry.lines.length - 1, Math.round(payload.lineIndex)));
    if (payload.skipped) { this.move(guildId, entry, index); return; }
    if (entry.offset > 0) {
      // Positive offset = lyrics later: hold the previous line for that long; the latest event wins.
      entry.pending = setTimeout(() => { entry.pending = undefined; this.move(guildId, entry, index); }, entry.offset);
      entry.pending.unref?.();
    } else if (entry.offset < 0) {
      // Negative offset = lyrics earlier: leap ahead using the plugin's own timestamps.
      this.move(guildId, entry, Math.max(index, indexAt(entry.times, entry.times[index]! - entry.offset)));
    } else this.move(guildId, entry, index);
  }

  private move(guildId: string, entry: Entry, index: number) {
    const clamped = Math.max(-1, Math.min(entry.lines.length - 1, index));
    if (this.entries.get(guildId) !== entry || clamped === entry.index) return;
    entry.index = clamped;
    void this.touch(guildId, true);
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
    // Node-pushed lines arrive exactly on time; this position check is only a seek/pause correction.
    const index = indexAt(entry.times, this.position(player, entry) - entry.offset + (entry.mode === 'push' ? 0 : LEAD_MS));
    if (index !== entry.index) { entry.index = index; void this.touch(player.guildId, true); }
    this.schedule(player);
  }

  /** One timer per boundary, cancelled while paused and re-armed on resume or playerUpdate. */
  private schedule(player: LyricsPlayer) {
    const entry = this.entries.get(player.guildId);
    if (!entry) return;
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = undefined; }
    if (entry.mode === 'push') return; // The node owns the boundary; nothing to arm here.
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
      const lines = await this.lookup(entry.track, true).catch(() => [] as LyricLine[]);
      if (this.entries.get(player.guildId) !== entry || entry.track !== player.queue.current) throw new Error('The track changed. Try again.');
      if (!lines.length) throw new Error('No synced lyrics are available for the current track.');
      entry.lines = lines.map(line => line.text);
      entry.times = lines.map(line => line.time);
    }
    entry.offset = Math.round(seconds * 1000);
    if (entry.pending) { clearTimeout(entry.pending); entry.pending = undefined; }
    this.align(player);
    return entry.offset / 1000;
  }

  /** Playback is over: drop the lines and the pending boundary. */
  forget(guildId: string) {
    const entry = this.entries.get(guildId);
    if (entry?.timer) clearTimeout(entry.timer);
    if (entry?.pending) clearTimeout(entry.pending);
    this.entries.delete(guildId);
  }

  /** Playback is over for this player: drop the state and release the node subscription. */
  stop(player: Pick<LyricsPlayer, 'guildId' | 'lyrics'>) {
    this.forget(player.guildId);
    if (this.subscribed.delete(player.guildId)) void player.lyrics?.unsubscribe().catch(() => {});
  }

  /** A failed panel edit is not worth surfacing: the next line tries again a moment later. */
  private touch(guildId: string, urgent = false) {
    return Promise.resolve(this.refresh(guildId, urgent)).catch(() => {});
  }
}