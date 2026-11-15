/**
 * Brand tokens: colors, emoji, links, asset names.
 * Every surface (cards, feedback) reads from here so the look stays consistent.
 *
 * Support and Invite are deployment-specific, so they come from the environment: a self-hosted copy
 * must point at its own server and its own application. Set SUPPORT_INVITE_URL in `.env`, and the
 * Invite link is built from this client's own application id. When a value is missing that link is
 * simply left out of the idle card instead of rendering a dead invite.
 */
export const BRAND = 'Sora';

export const COLORS = {
  idle: '#5865F2',
  playing: '#5865F2',
  paused: '#F0B232',
} as const;

/** Deliberately few emoji: one per control button, one per feedback line. */
export const EMOJI = {
  previous: '⏮️',
  paused: '⏸️',
  playing: '▶️',
  next: '⏭️',
  stop: '⏹️',
  queue: '📜',
  autoplay: '🔁',
  lyrics: '🎤',
  added: '✅',
  failed: '⚠️',
} as const;

/** Administrator, View Channel, Send Messages, Manage Messages, Connect, Speak, Attach Files. */
const DEFAULT_PERMISSIONS = '8';

function httpURL(value?: string) {
  if (!value) return undefined;
  try {
    const url = new URL(value.trim());
    return ['http:', 'https:'].includes(url.protocol) ? url.href : undefined;
  } catch { return undefined; }
}

/** Built from this deployment's own application id, so the link can never point at another bot. */
export function inviteURL(botId?: string) {
  if (!botId) return undefined;
  const permissions = process.env.INVITE_PERMISSIONS?.trim() || DEFAULT_PERMISSIONS;
  return `https://discord.com/oauth2/authorize?client_id=${botId}&permissions=${permissions}&scope=bot%20applications.commands`;
}

/** Optional: the invite to this bot's own support server, if the operator runs one. */
export function supportURL() {
  return httpURL(process.env.SUPPORT_INVITE_URL);
}

export const BANNER = 'idle-banner.png';
