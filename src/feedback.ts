import { EMOJI } from './ui/theme.js';

/** Actions the panel and slash commands can drive. */
export type ControlAction = 'pause' | 'resume' | 'previous' | 'next' | 'skip' | 'stop';

/** Every user-facing Sora string in one place, so copy never drifts between surfaces. */
export const FEEDBACK: Record<ControlAction, string> = {
  pause: `${EMOJI.paused} Playback paused.`,
  resume: `${EMOJI.playing} Playback resumed.`,
  previous: `${EMOJI.previous} Playing the previous track.`,
  next: `${EMOJI.next} Skipped to the next track.`,
  skip: `${EMOJI.next} Skipped to the next track.`,
  stop: `${EMOJI.stop} Playback stopped. Queue cleared and voice disconnected.`,
};

/** `skip` is the slash-command spelling of `next`; both answer with the same line. */
export const editedCopy = (action: ControlAction) => FEEDBACK[action];

export const added = (title: string, extra: number) => `${EMOJI.added} Added: ${title}${extra > 0 ? ` (+${extra} tracks)` : ''}`;
export const failed = (reason: string) => `${EMOJI.failed} Request failed: ${reason}`;

/** Autoplay is a toggle, so one line covers both outcomes. */
export const autoplayCopy = (on: boolean) => `${EMOJI.autoplay} Autoplay ${on ? 'enabled' : 'disabled'}.`;

/** Lyric offset is absolute for this playback and resets on the next track. */
export const lyricsSyncCopy = (seconds: number) => seconds === 0
  ? `${EMOJI.lyrics} Lyrics restored to the original timing.`
  : `${EMOJI.lyrics} Lyrics shifted ${seconds > 0 ? 'later' : 'earlier'} by ${Math.abs(seconds)}s.`;

/** Only stop is confirmed publicly; every other control answers privately. */
export const PUBLIC_ACTIONS = new Set<ControlAction>(['stop']);
