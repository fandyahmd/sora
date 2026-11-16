import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GuildStore } from '../src/services/db.js';
import { migrateSqlite } from '../scripts/migrate-sqlite.js';

test('store rejects missing and non-libsql configuration', async () => {
  for (const value of ['', 'postgres://localhost/db', 'https://example.com']) {
    await assert.rejects(() => GuildStore.open(value, ''), /TURSO_URL/);
  }
  await assert.rejects(() => GuildStore.open('libsql://host', undefined), /TURSO_AUTH_TOKEN/);
});

// Runs offline against a local `file:` database; no server or credentials required.
test('libSQL upsert, restart, toggles, teardown, failure and SQLite import', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sora-libsql-'));
  const url = `file:${join(dir, 'sora.db')}`;
  const stores: GuildStore[] = [];
  const open = async () => { const store = await GuildStore.open(url); stores.push(store); return store; };
  try {
    const store = await open();
    assert.equal(store.has('a'), false);
    assert.equal(await store.toggleAutoplay('a'), true);
    await store.set('a', { requestChannelId: 'channel', panelMessageId: 'old', channelOwned: true });
    await store.set('a', { requestChannelId: 'channel', panelMessageId: 'new', channelOwned: true });
    assert.equal(store.has('a'), true, 'binding upsert preserves autoplay');
    await store.close();

    const restored = await open();
    assert.deepEqual(restored.get('a'), { requestChannelId: 'channel', panelMessageId: 'new', channelOwned: true });
    assert.equal(restored.has('a'), true);
    const flips = await Promise.all(Array.from({ length: 20 }, () => restored.toggleAutoplay('a')));
    assert.equal(flips.filter(Boolean).length, 10, 'serialized toggles stay atomic');
    assert.equal(restored.has('a'), true);

    const before = restored.get('a');
    await assert.rejects(() => restored.set('a', { requestChannelId: '', panelMessageId: 'invalid' }), /Unable to save/);
    assert.deepEqual(restored.get('a'), before, 'failed persistence cannot mutate cache');

    await restored.clear('a');
    assert.equal(restored.get('a'), undefined);
    assert.equal(restored.has('a'), false);
    await restored.toggleAutoplay('autoplay-only');
    assert.equal(restored.get('autoplay-only'), undefined);
    assert.equal(restored.entries().length, 0);

    // Legacy SQLite import: rerunnable, existing guilds win, source byte-identical.
    const path = join(dir, 'legacy.sqlite');
    const sqlite = new Database(path);
    sqlite.exec(`CREATE TABLE guilds (guild_id TEXT PRIMARY KEY, request_channel_id TEXT, panel_message_id TEXT, autoplay INTEGER, sora_created INTEGER);
      INSERT INTO guilds VALUES ('legacy', 'text', 'panel', 1, 1), ('autoplay-only', NULL, NULL, 0, NULL)`);
    sqlite.close();
    const original = await readFile(path);
    assert.deepEqual(await migrateSqlite(path, url), { imported: 1, skipped: 1 });
    assert.deepEqual(await migrateSqlite(path, url), { imported: 0, skipped: 2 });
    assert.deepEqual(await readFile(path), original);
    const migrated = await open();
    assert.deepEqual(migrated.get('legacy'), { requestChannelId: 'text', panelMessageId: 'panel', channelOwned: true });
    assert.equal(migrated.has('legacy'), true);
    assert.equal(migrated.has('autoplay-only'), true, 'rerun never overwrites existing state');
    await migrated.close();
    await assert.rejects(() => migrated.clear('legacy'), /Unable to clear/);
    assert.ok(migrated.get('legacy'), 'failed delete retains cached binding');
  } finally {
    for (const store of stores) store.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
