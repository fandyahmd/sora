/**
 * Sanitising helpers shared by every card. Track metadata is untrusted input.
 * Backslash escaping is not an option: Discord renders `\(` literally inside Components V2,
 * so markdown-structural characters are removed outright and ordinary punctuation survives.
 */
const STRUCTURAL = /[\\`*_[\]<>|~]/g;
function sanitize(value: string, limit: number) {
  return value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/@/g, '@\u200b').replace(STRUCTURAL, '')
    .replace(/\s{2,}/g, ' ').trim().slice(0, limit);
}
export function displayText(value: string, limit = 180) {
  return sanitize(value, limit) || 'Unknown';
}

/**
 * Lyrics are quoted lines rather than metadata: heading markers go too, because a sung `#` would
 * otherwise restyle the card from inside the emphasis we add ourselves. An empty line stays empty.
 */
export function lyricText(value: string, limit = 120) {
  return sanitize(value, limit).replace(/#/g, '').trim();
}

/** Bound a pre-formatted block without escaping the markdown we wrote ourselves. */
export function clip(value: string, limit: number) {
  return value.length > limit ? `${value.slice(0, limit - 3)}...` : value;
}

/** Only plain, credential-free http(s) URLs survive; everything else renders as nothing. */
export function httpURL(value?: string | null) {
  if (!value || value.length > 1000 || /[\s\u0000-\u001f\u007f]/.test(value)) return;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return;
    return url.href.replace(/[()<>]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  } catch { return; }
}

export function duration(length?: number, isStream?: boolean) {
  if (isStream) return 'Live stream';
  if (!Number.isFinite(length) || !length || length < 0 || length > Number.MAX_SAFE_INTEGER) return 'Unknown';
  const seconds = Math.floor(length / 1000);
  const hours = Math.floor(seconds / 3600);
  return `${hours ? `${hours}:` : ''}${hours ? String(Math.floor(seconds / 60) % 60).padStart(2, '0') : Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
