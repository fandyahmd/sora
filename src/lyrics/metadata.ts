/**
 * Track-metadata cleanup and edition matching, shared by every provider.
 *
 * One song exists as a studio cut, an official video with a spoken intro, a live take and a remix,
 * each with its own timings. A candidate must agree on artist, title, version qualifiers AND
 * duration before its lines may drive the panel; duration alone is never proof of identical intros.
 */
import type { LyricsTrack } from './types.js';

/** Duration is a filter, never proof of identical intros. Reject loose studio/video matches. */
export const DURATION_TOLERANCE_MS = 3_000;
/** /lyrics-sync rescues accept a loose duration: the human has confirmed it is the right song. */
export const MANUAL_TOLERANCE_MS = 120_000;

/** Strip brackets, upload noise and separator tails: `X (Official Video)` -> `X`. */
export function clean(value?: string) {
  return (value ?? '')
    .replace(/\([^()]*\)|\[[^\]]*\]/g, ' ')
    .replace(/\s*[|/]\s*/g, ' ')
    .replace(/\b(official|lyric|lyrics|video|audio|hd|hq|mv|m\/v|visualizer|remaster(?:ed)?|color\s?coded)\b/gi, ' ')
    .replace(/\s{2,}/g, ' ').trim();
}
/** YouTube channel handles are not artist names: `HarryStylesVEVO` -> `Harry Styles`. */
export function cleanArtist(value?: string) {
  return clean(value).replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/i, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\s{2,}/g, ' ').trim();
}

export function normalize(value?: string) {
  return (value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
export function versions(value?: string) {
  return [...new Set((normalize(value).match(/\b(?:live|remix|acoustic|instrumental|karaoke|cover|sped up|speed up|slowed|nightcore|radio edit|extended)\b/g) ?? [])
    .map(version => version === 'speed up' ? 'sped up' : version))].sort().join('|');
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

/**
 * Edition labels carried by an upload or a provider entry: `(Official Lyric Video)`, `(Audio)`,
 * `(Official Music Video)`, live/remix takes... LRCLIB holds several timings for one song — a lyric
 * video, the studio audio and a music video with a skit intro do not share a timeline, and their
 * durations are near-identical, so duration alone cannot pick the right one. Matching the label of
 * the playing upload against the label of the candidate is the signal that survives that tie.
 */
export function editionLabels(value?: string): string[] {
  const found = normalize(value).match(/\b(?:lyrics? video|music video|official video|visualizer|audio|video|live|remix|acoustic|cover|instrumental|karaoke|slowed|sped up|speed up|nightcore|extended|radio edit|lyrics?)\b/g) ?? [];
  const mapped = found.map(label =>
    label === 'speed up' ? 'sped up'
    : label === 'lyric' || label === 'lyrics' || label === 'lyrics video' ? 'lyric video'
    : label === 'video' || label === 'official video' ? 'music video'
    : label);
  return [...new Set(mapped)];
}

/**
 * Does a provider's candidate describe the same recording as the playing track?
 * `durationSeconds` may be 0/undefined when the provider does not know it; the remaining
 * checks still apply. Version qualifiers (live, remix, slowed...) must match exactly.
 */
export function editionMatches(
  candidate: { title?: string; artist?: string; durationSeconds?: number },
  track: LyricsTrack,
  queries: ReturnType<typeof deriveQueries>,
  tolerance: number,
) {
  if (versions(track.info.title) !== versions(candidate.title)) return false;
  const title = normalize(clean(candidate.title));
  const artist = normalize(cleanArtist(candidate.artist));
  if (!title || !artist || !queries.some(query => normalize(query.title) === title && normalize(query.artist) === artist)) return false;
  const length = track.info.length ?? 0;
  const duration = candidate.durationSeconds ?? 0;
  if (!length || !Number.isFinite(duration) || duration <= 0) return length > 0; // Unknown provider duration: metadata matched, keep it.
  return Math.abs(duration * 1000 - length) <= tolerance;
}