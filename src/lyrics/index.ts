/**
 * Live lyrics module.
 *
 *   types     shared contracts (provider, player, panel slice)
 *   lrc       LRC parsing + line indexing (pure)
 *   metadata  YouTube-noise cleanup + strict edition matching (pure)
 *   lrclib    primary provider: keyless community database
 *   musixmatch fallback provider: Soundy's third path
 *   cache     LRU so replays and autoplay repeats cost nothing
 *   lookup    provider chain + cache composition
 *   service   the clock: push events, boundary timers, pause/seek, /lyrics-sync offset
 */
export { parseLRC, indexAt, MAX_TIMER_MS } from './lrc.js';
export { deriveQueries, clean, cleanArtist, normalize, versions, editionMatches, DURATION_TOLERANCE_MS, MANUAL_TOLERANCE_MS } from './metadata.js';
export { lookupLRCLIB } from './lrclib.js';
export { lookupMusixmatch } from './musixmatch.js';
export { withCache } from './cache.js';
export { chain, lookupLyrics } from './lookup.js';
export { LyricsService } from './service.js';
export type { LyricLine, LyricsSlice, LyricsTrack, LyricsNode, LyricsNodeResult, LyricsPlayer, LyricsLookup } from './types.js';