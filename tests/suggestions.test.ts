import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { Suggestions } from '../src/services/suggestions.js';

test('suggestions isolate guilds, retain full tracks, and expire', () => {
  const cache = new Suggestions<{ encoded: string }>(10);
  const track = { encoded: 'encoded-track' };
  const value = cache.put('guild-a', track, 100);
  assert.equal(cache.get('guild-a', value, 105), track);
  assert.equal(cache.get('guild-b', value, 105), undefined);
  assert.equal(cache.get('guild-a', value, 110), undefined);
  assert.equal(cache.get('guild-a', 'https://example.com', 105), undefined);
});
