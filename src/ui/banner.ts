import { readFileSync } from 'node:fs';
import { BANNER } from './theme.js';

/** The idle banner travels with the idle payload; playing payloads send `attachments: []` to drop it. */
export function bannerFile() {
  return [{ filename: BANNER, data: readFileSync(new URL(`../../assets/${BANNER}`, import.meta.url)), contentType: 'image/png' }];
}
