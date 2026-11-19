/**
 * In-memory LRU around a lyrics lookup. Replays, autoplay repeats and multi-guild plays of the
 * same recording resolve instantly and cost the providers nothing. Promises are cached so two
 * guilds starting the same song share one request; a rejected entry is evicted, never pinned.
 *
 * ponytail: process-local and unbounded in time (lyrics do not change); add a TTL or shared
 * store only if a second process ever serves the same guilds.
 */
import type { LyricLine, LyricsLookup, LyricsTrack } from './types.js';

const MAX_ENTRIES = 256;

function key(track: LyricsTrack, manual?: boolean) {
  const { title = '', author = '', length = 0 } = track.info;
  return `${author}\u0000${title}\u0000${length}\u0000${manual ? 1 : 0}`;
}

export function withCache(lookup: LyricsLookup, max = MAX_ENTRIES): LyricsLookup {
  const entries = new Map<string, Promise<LyricLine[]>>();
  return (track, manual) => {
    const id = key(track, manual);
    const hit = entries.get(id);
    if (hit) {
      entries.delete(id); entries.set(id, hit); // Refresh recency.
      return hit;
    }
    const pending = lookup(track, manual).catch(error => { entries.delete(id); throw error; });
    entries.set(id, pending);
    if (entries.size > max) entries.delete(entries.keys().next().value as string);
    return pending;
  };
}