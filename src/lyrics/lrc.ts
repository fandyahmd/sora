/** LRC parsing and line indexing — pure functions, no provider or player knowledge. */
import type { LyricLine } from './types.js';

/** setTimeout's 32-bit ceiling; larger delays fire immediately, so they must never be armed. */
export const MAX_TIMER_MS = 2_147_483_647;

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