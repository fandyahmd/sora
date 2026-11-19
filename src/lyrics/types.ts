/** Shared contracts for the lyrics module: providers, clocks and the panel all speak these types. */

/** One timed line, milliseconds from track start. */
export type LyricLine = { time: number; text: string };
/** What the panel renders: the whole song as plain lines, plus the index being sung (-1 before the first). */
export type LyricsSlice = { lines: readonly string[]; index: number };
/** The track metadata a lookup needs; a subset of Hoshimi's Track. */
export type LyricsTrack = { info: { title?: string; author?: string; length?: number; isStream?: boolean } };
/** What a node lyrics plugin answers once subscribed (Hoshimi's `LyricsResult`, narrowed). */
export type LyricsNodeResult = { provider?: string; lines?: readonly { timestamp: number; line: string }[] | null };
/** Hoshimi's `player.lyrics` surface; present only when the node runs a lyrics plugin. */
export type LyricsNode = { subscribe: () => Promise<unknown>; unsubscribe: () => Promise<unknown>; current: () => Promise<LyricsNodeResult | null> };
/** The only player surface the service touches, so it can be tested without Lavalink. */
export type LyricsPlayer = { guildId: string; position: number; lastPosition?: number; isPaused?: () => boolean; queue: { current?: LyricsTrack | null }; lyrics?: LyricsNode };
/** A lyrics source. `manual` relaxes duration matching for /lyrics-sync rescues. Empty array = no verified match. */
export type LyricsLookup = (track: LyricsTrack, manual?: boolean) => Promise<LyricLine[]>;