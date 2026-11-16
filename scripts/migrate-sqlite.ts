import { Database } from 'bun:sqlite';
import { SQL } from 'bun';
import { existsSync } from 'node:fs';
import { GuildStore } from '../src/services/db.js';

/** Explicit, rerunnable import. Existing PostgreSQL guilds always win; SQLite is read-only. */
export async function migrateSqlite(path: string, url = process.env.DATABASE_URL) {
  if (!existsSync(path)) throw new Error('SQLite source does not exist.');
  // Reuse the application's configuration, connectivity and schema checks before importing anything.
  const store = await GuildStore.open(url);
  await store.close();
  const source = new Database(path, { readonly: true });
  let rows: Array<{ guild_id: string; request_channel_id: string | null; panel_message_id: string | null; autoplay: number; sora_created: number | null }>;
  try {
    const columns = source.query<{ name: string }, []>('PRAGMA table_info(guilds)').all();
    rows = source.query(`SELECT guild_id, request_channel_id, panel_message_id, autoplay,
      ${columns.some(column => column.name === 'sora_created') ? 'sora_created' : 'NULL AS sora_created'} FROM guilds`).all() as typeof rows;
    for (const row of rows) {
      if (typeof row.guild_id !== 'string' || !row.guild_id || ![0, 1].includes(row.autoplay)
        || ![null, 0, 1].includes(row.sora_created)
        || !((row.request_channel_id === null && row.panel_message_id === null)
          || (typeof row.request_channel_id === 'string' && !!row.request_channel_id && typeof row.panel_message_id === 'string' && !!row.panel_message_id))) {
        throw new Error('Invalid SQLite guild row. Import aborted without changes.');
      }
    }
  } finally { source.close(); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url!).hostname);
  const db = new SQL(url!, { tls: local ? false : { rejectUnauthorized: true } });
  try {
    return await db.begin(async tx => {
      let imported = 0;
      for (const row of rows) {
        const result = await tx`INSERT INTO public.sora_guilds (guild_id, request_channel_id, panel_message_id, autoplay, sora_created)
          VALUES (${row.guild_id}, ${row.request_channel_id}, ${row.panel_message_id}, ${row.autoplay === 1}, ${row.sora_created === 1})
          ON CONFLICT (guild_id) DO NOTHING RETURNING guild_id`;
        imported += result.length;
      }
      return { imported, skipped: rows.length - imported };
    });
  } catch { throw new Error('SQLite import failed; transaction rolled back. Check the source and PostgreSQL configuration.'); }
  finally { await db.close(); }
}

if (import.meta.main) {
  try {
    const path = process.argv[2];
    if (!path) throw new Error('Usage: bun run migrate:sqlite /path/to/sora.sqlite');
    const result = await migrateSqlite(path);
    console.log(`Imported ${result.imported} guilds; skipped ${result.skipped} existing guilds. SQLite source unchanged.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'SQLite import failed.');
    process.exitCode = 1;
  }
}
