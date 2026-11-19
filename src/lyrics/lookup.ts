/** Provider chain: first verified match wins. LRCLIB is keyless and community-run, so it goes first;
 * Musixmatch covers what LRCLIB lacks. The shared cache sits in front of the whole chain. */
import { withCache } from './cache.js';
import { lookupLRCLIB } from './lrclib.js';
import { lookupMusixmatch } from './musixmatch.js';
import type { LyricLine, LyricsLookup } from './types.js';

export function chain(...providers: LyricsLookup[]): LyricsLookup {
  return async (track, manual) => {
    for (const provider of providers) {
      const lines = await provider(track, manual).catch(() => [] as LyricLine[]);
      if (lines.length) return lines;
    }
    return [];
  };
}

/** The default lookup the service uses: cached LRCLIB -> Musixmatch. */
export const lookupLyrics = withCache(chain(lookupLRCLIB, lookupMusixmatch));