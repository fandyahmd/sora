import { Database } from 'bun:sqlite';
import { createClient } from '@libsql/client';
import { existsSync } from 'node:fs';

/** Explicit, rerunnable import from a legacy local `bun:sqlite` file into Turso. Existing guilds win. */
export async function migrateSqlite(
  path: string,
  url = process.env.TURSO_URL,
  authToken = process.env.TURSO_AUTH_TOKEN,
) {
  if (!existsSync(path)) throw new Error('SQLite source does not exist.');
  if (!url || (!url.startsWith('libsql://') && !url.startsWith('file:'))) {
    throw new Error('TURSO_URL must be a libsql:// or file: URL.');
  }
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

  const db = createClient({ url, ...(authToken?.trim() ? { authToken: authToken.trim() } : {}) });
  let imported = 0;
  try {
    for (const row of rows) {
      const result = await db.execute({
        sql: `INSERT INTO sora_guilds (guild_id, request_channel_id, panel_message_id, autoplay, sora_created)
          VALUES (?, ?, ?, ?, ?) ON CONFLICT (guild_id) DO NOTHING`,
        args: [row.guild_id, row.request_channel_id, row.panel_message_id, row.autoplay, row.sora_created ?? 0],
      });
      imported += Number(result.rowsAffected);
    }
  } finally { db.close(); }
  return { imported, skipped: rows.length - imported };
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
