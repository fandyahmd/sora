/**
 * One SQLite file for everything Sora remembers per guild: the request-channel panel
 * binding and the autoplay switch. `bun:sqlite` ships with the runtime, so no dependency
 * and no hand-rolled temp-write/rename dance.
 *
 * The path comes from DATABASE_PATH (default ./data/sora.sqlite). On a host with an ephemeral
 * filesystem — Render and Koyeb both give you one — point it at a mounted disk or volume, or every
 * deploy silently starts from an empty database and each guild must set itself up again.
 */
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** `channelOwned` means Sora created the channel itself, so it may delete it again. */
export type GuildBinding = { requestChannelId: string; panelMessageId: string; channelOwned?: boolean };

type BindingRow = { guild_id: string; request_channel_id: string; panel_message_id: string; sora_created: number | null };

export class GuildStore {
  private readonly db: Database;
  constructor(private readonly path = process.env.DATABASE_PATH?.trim() || './data/sora.sqlite') {
    mkdirSync(dirname(path), { recursive: true });
    console.log(`Store: ${path}`);
    // ponytail: one long-lived connection per process; close it only if a second process ever needs the file.
    this.db = new Database(path, { create: true });
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS guilds (
      guild_id TEXT PRIMARY KEY,
      request_channel_id TEXT,
      panel_message_id TEXT,
      autoplay INTEGER NOT NULL DEFAULT 0,
      sora_created INTEGER
    ) STRICT`);
    this.addMissingColumns();
    this.importLegacyJson();
  }

  /** CREATE TABLE IF NOT EXISTS never alters an existing table, so a database made before a column was added needs it appended. */
  private addMissingColumns() {
    const columns = new Set(this.db.query<{ name: string }, []>('PRAGMA table_info(guilds)').all().map(column => column.name));
    if (!columns.has('sora_created')) this.db.exec('ALTER TABLE guilds ADD COLUMN sora_created INTEGER');
  }

  /** Fold the older JSON files in once, so an upgrade keeps the guilds that were already set up. */
  private importLegacyJson() {
    const dir = dirname(this.path);
    const guilds = join(dir, 'guilds.json');
    if (existsSync(guilds)) {
      const data: unknown = JSON.parse(readFileSync(guilds, 'utf8'));
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        for (const [guildId, value] of Object.entries(data as Record<string, GuildBinding>)) {
          if (typeof value?.requestChannelId === 'string' && typeof value?.panelMessageId === 'string') this.set(guildId, value);
        }
      }
      renameSync(guilds, `${guilds}.migrated`);
    }
    const autoplay = join(dir, 'autoplay.json');
    if (existsSync(autoplay)) {
      const data: unknown = JSON.parse(readFileSync(autoplay, 'utf8'));
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        for (const [guildId, value] of Object.entries(data as Record<string, boolean>)) if (value === true) this.toggleAutoplay(guildId);
      }
      renameSync(autoplay, `${autoplay}.migrated`);
    }
  }

  private static readonly SELECT = 'SELECT guild_id, request_channel_id, panel_message_id, sora_created FROM guilds WHERE request_channel_id IS NOT NULL AND panel_message_id IS NOT NULL';
  private static readonly binding = (row: BindingRow): GuildBinding => ({
    requestChannelId: row.request_channel_id, panelMessageId: row.panel_message_id,
    // Absent means the channel was chosen by a person, so Sora must never delete it.
    ...(row.sora_created === 1 ? { channelOwned: true } : {}),
  });

  get(guildId: string): GuildBinding | undefined {
    const row = this.db.query<BindingRow, [string]>(`${GuildStore.SELECT} AND guild_id = ?`).get(guildId);
    return row ? GuildStore.binding(row) : undefined;
  }

  entries(): Array<[string, GuildBinding]> {
    return this.db.query<BindingRow, []>(GuildStore.SELECT).all().map(row => [row.guild_id, GuildStore.binding(row)]);
  }

  set(guildId: string, binding: GuildBinding) {
    this.db.query(`INSERT INTO guilds (guild_id, request_channel_id, panel_message_id, sora_created) VALUES (?, ?, ?, ?)
      ON CONFLICT(guild_id) DO UPDATE SET request_channel_id = excluded.request_channel_id, panel_message_id = excluded.panel_message_id, sora_created = excluded.sora_created`)
      .run(guildId, binding.requestChannelId, binding.panelMessageId, binding.channelOwned ? 1 : null);
  }

  /** Drop everything remembered for a guild: panel binding and autoplay alike. */
  clear(guildId: string) {
    this.db.query('DELETE FROM guilds WHERE guild_id = ?').run(guildId);
  }

  /** Autoplay is off unless a guild asked for it, matching Hoshimi's own default. */
  has(guildId: string) {
    return this.db.query<{ autoplay: number }, [string]>('SELECT autoplay FROM guilds WHERE guild_id = ?').get(guildId)?.autoplay === 1;
  }

  /** Returns the state after the flip. */
  toggleAutoplay(guildId: string) {
    const next = this.has(guildId) ? 0 : 1;
    this.db.query(`INSERT INTO guilds (guild_id, autoplay) VALUES (?, ?)
      ON CONFLICT(guild_id) DO UPDATE SET autoplay = excluded.autoplay`).run(guildId, next);
    return next === 1;
  }
}
