import { createClient, type Client } from '@libsql/client';

/** Only channels created by Sora may be deleted during teardown. */
export type GuildBinding = { requestChannelId: string; panelMessageId: string; channelOwned?: boolean };
type GuildRow = { guild_id: string; request_channel_id: string | null; panel_message_id: string | null; autoplay: number; sora_created: number };

const SCHEMA_URL = new URL('../../sql/schema.sql', import.meta.url);

/** libSQL returns rows as `{ [column]: unknown }`; coerce the known columns into the cache shape. */
function toRow(raw: Record<string, unknown>): GuildRow {
  return {
    guild_id: String(raw.guild_id),
    request_channel_id: raw.request_channel_id == null ? null : String(raw.request_channel_id),
    panel_message_id: raw.panel_message_id == null ? null : String(raw.panel_message_id),
    autoplay: Number(raw.autoplay),
    sora_created: Number(raw.sora_created),
  };
}

/** One hydrated cache per bot process. Every mutation commits before changing the cache. */
export class GuildStore {
  private readonly rows = new Map<string, GuildRow>();
  private readonly pending = new Map<string, Promise<unknown>>();
  private constructor(private readonly db: Client) {}

  static async open(url = process.env.TURSO_URL, authToken = process.env.TURSO_AUTH_TOKEN) {
    const trimmed = url?.trim() ?? '';
    if (!trimmed) throw new Error('TURSO_URL must be set (libsql://host or file:path).');
    if (!trimmed.startsWith('libsql://') && !trimmed.startsWith('file:')) {
      throw new Error('TURSO_URL must use the libsql:// or file: scheme.');
    }
    if (trimmed.startsWith('libsql://') && !authToken?.trim()) {
      throw new Error('TURSO_AUTH_TOKEN must be set for a remote libsql:// database.');
    }
    const db = createClient({ url: trimmed, ...(authToken?.trim() ? { authToken: authToken.trim() } : {}) });
    const store = new GuildStore(db);
    try {
      await db.execute(await Bun.file(SCHEMA_URL).text());
      const result = await db.execute(
        'SELECT guild_id, request_channel_id, panel_message_id, autoplay, sora_created FROM sora_guilds',
      );
      for (const raw of result.rows) {
        const row = toRow(raw);
        store.rows.set(row.guild_id, row);
      }
      return store;
    } catch {
      db.close();
      // Driver errors can contain connection details. Do not expose credentials in logs or Discord replies.
      throw new Error('Turso initialization failed. Check TURSO_URL, TURSO_AUTH_TOKEN and connectivity.');
    }
  }

  private serial<T>(guildId: string, task: () => Promise<T>): Promise<T> {
    const next = (this.pending.get(guildId) ?? Promise.resolve()).catch(() => {}).then(task);
    this.pending.set(guildId, next);
    void next.finally(() => { if (this.pending.get(guildId) === next) this.pending.delete(guildId); }).catch(() => {});
    return next;
  }

  get(guildId: string): GuildBinding | undefined {
    const row = this.rows.get(guildId);
    if (!row?.request_channel_id || !row.panel_message_id) return undefined;
    return { requestChannelId: row.request_channel_id, panelMessageId: row.panel_message_id,
      ...(row.sora_created === 1 ? { channelOwned: true } : {}) };
  }

  entries(): Array<[string, GuildBinding]> {
    return [...this.rows.keys()].sort().flatMap(id => { const binding = this.get(id); return binding ? [[id, binding] as [string, GuildBinding]] : []; });
  }

  set(guildId: string, binding: GuildBinding) {
    return this.serial(guildId, async () => {
      try {
        const result = await this.db.execute({
          sql: `INSERT INTO sora_guilds (guild_id, request_channel_id, panel_message_id, sora_created)
            VALUES (?, ?, ?, ?)
            ON CONFLICT (guild_id) DO UPDATE SET request_channel_id = excluded.request_channel_id,
            panel_message_id = excluded.panel_message_id, sora_created = excluded.sora_created
            RETURNING guild_id, request_channel_id, panel_message_id, autoplay, sora_created`,
          args: [guildId, binding.requestChannelId, binding.panelMessageId, binding.channelOwned === true ? 1 : 0],
        });
        const row = toRow(result.rows[0]);
        this.rows.set(guildId, row);
      } catch { throw new Error('Unable to save guild settings. Please try again.'); }
    });
  }

  clear(guildId: string) {
    return this.serial(guildId, async () => {
      try {
        await this.db.execute({ sql: 'DELETE FROM sora_guilds WHERE guild_id = ?', args: [guildId] });
        this.rows.delete(guildId);
      } catch { throw new Error('Unable to clear guild settings. Please try again.'); }
    });
  }

  has(guildId: string) { return this.rows.get(guildId)?.autoplay === 1; }

  toggleAutoplay(guildId: string) {
    return this.serial(guildId, async () => {
      try {
        const result = await this.db.execute({
          sql: `INSERT INTO sora_guilds (guild_id, autoplay) VALUES (?, 1)
            ON CONFLICT (guild_id) DO UPDATE SET autoplay = NOT sora_guilds.autoplay
            RETURNING guild_id, request_channel_id, panel_message_id, autoplay, sora_created`,
          args: [guildId],
        });
        const row = toRow(result.rows[0]);
        this.rows.set(guildId, row);
        return row.autoplay === 1;
      } catch { throw new Error('Unable to save autoplay settings. Please try again.'); }
    });
  }

  async close() {
    await Promise.allSettled(this.pending.values());
    this.db.close();
  }
}
