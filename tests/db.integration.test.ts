import assert from 'node:assert/strict';
import { test } from 'bun:test';
import { SQL } from 'bun';
import { Database } from 'bun:sqlite';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GuildStore } from '../src/services/db.js';
import { migrateSqlite } from '../scripts/migrate-sqlite.js';

const url = process.env.TEST_DATABASE_URL;

test('store rejects missing and non-PostgreSQL configuration', async () => {
  for (const value of ['', 'sqlite://data/sora.sqlite', 'https://example.com', 'postgres://localhost']) {
    await assert.rejects(() => GuildStore.open(value), /DATABASE_URL/);
  }
});

// Explicit opt-in, loopback and dedicated database guard: never run against the bot's remote database.
(url ? test : test.skip)('PostgreSQL upsert, restart, concurrent toggles, teardown, failure and SQLite import', async () => {
  const parsed = new URL(url!);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname));
  assert.equal(parsed.pathname, '/sora_test');
  const db = new SQL(url!, { tls: false });
  const stores: GuildStore[] = [];
  const open = async () => { const store = await GuildStore.open(url); stores.push(store); return store; };
  const dir = await mkdtemp(join(tmpdir(), 'sora-pg-'));
  try {
    await db.unsafe(await Bun.file(new URL('../sql/schema.sql', import.meta.url)).text()).simple();
    await db.unsafe(await Bun.file(new URL('../sql/schema.sql', import.meta.url)).text()).simple();
    await db`TRUNCATE public.sora_guilds`;
    const [security] = await db`SELECT relrowsecurity FROM pg_class WHERE oid = 'public.sora_guilds'::regclass`;
    assert.equal(security.relrowsecurity, true);
    await db`INSERT INTO public.sora_guilds (guild_id) VALUES ('private')`;
    await db`CREATE ROLE sora_api_test NOLOGIN`;
    try {
      await db`GRANT USAGE ON SCHEMA public TO sora_api_test`;
      await db`GRANT SELECT, INSERT ON public.sora_guilds TO sora_api_test`;
      await db.begin(async tx => {
        await tx`SET LOCAL ROLE sora_api_test`;
        assert.equal((await tx`SELECT * FROM public.sora_guilds`).length, 0, 'RLS hides existing guilds');
      });
      await assert.rejects(() => db.begin(async tx => {
        await tx`SET LOCAL ROLE sora_api_test`;
        await tx`INSERT INTO public.sora_guilds (guild_id) VALUES ('forbidden')`;
      }), /row-level security/);
    } finally {
      await db`REVOKE ALL ON public.sora_guilds FROM sora_api_test`;
      await db`REVOKE ALL ON SCHEMA public FROM sora_api_test`;
      await db`DROP ROLE sora_api_test`;
      await db`DELETE FROM public.sora_guilds WHERE guild_id = 'private'`;
    }
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
    assert.equal(flips.filter(Boolean).length, 10);
    assert.equal(restored.has('a'), true);
    const other = await open();
    const concurrent = await Promise.all(Array.from({ length: 21 }, (_, i) => (i % 2 ? restored : other).toggleAutoplay('a')));
    assert.equal(concurrent.filter(Boolean).length, 10, 'SQL toggle remains atomic across separate connections');
    const latest = await open();
    assert.equal(latest.has('a'), false);
    assert.equal(latest.get('a')?.panelMessageId, 'new');
    const before = latest.get('a');
    await assert.rejects(() => latest.set('a', { requestChannelId: '', panelMessageId: 'invalid' }), /Unable to save/);
    assert.deepEqual(latest.get('a'), before, 'failed persistence cannot mutate cache');
    await latest.clear('a');
    assert.equal(latest.get('a'), undefined);
    assert.equal(latest.has('a'), false);
    const cleared = await open();
    assert.equal(cleared.entries().length, 0);
    await cleared.toggleAutoplay('autoplay-only');
    assert.equal(cleared.get('autoplay-only'), undefined);
    assert.equal(cleared.entries().length, 0);

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
    assert.equal(migrated.has('autoplay-only'), true, 'rerun never overwrites existing PostgreSQL state');
    await migrated.close();
    await assert.rejects(() => migrated.clear('legacy'), /Unable to clear/);
    assert.ok(migrated.get('legacy'), 'failed delete retains cached binding');
  } finally {
    for (const store of stores) await store.close();
    await db`DROP TABLE public.sora_guilds`;
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
