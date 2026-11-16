import { SQL } from 'bun';

/** Only channels created by Sora may be deleted during teardown. */
export type GuildBinding = { requestChannelId: string; panelMessageId: string; channelOwned?: boolean };
type GuildRow = { guild_id: string; request_channel_id: string | null; panel_message_id: string | null; autoplay: boolean; sora_created: boolean };

/** One hydrated cache per bot process. Every mutation commits before changing the cache. */
export class GuildStore {
  private readonly rows = new Map<string, GuildRow>();
  private readonly pending = new Map<string, Promise<unknown>>();
  private constructor(private readonly db: SQL) {}

  static async open(url = process.env.DATABASE_URL) {
    let parsed: URL;
    try { parsed = new URL(url ?? ''); } catch { throw new Error('DATABASE_URL must be a PostgreSQL connection URL.'); }
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname || !parsed.username || parsed.pathname.length < 2) {
      throw new Error('DATABASE_URL must include a PostgreSQL host, user, and database.');
    }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
    // Supabase serves its pooler (and direct host) behind a private CA that is not in the public trust
    // store, so `rejectUnauthorized` alone would reject a legitimate connection. Detect the host and pin
    // the bundled Supabase roots; everything else keeps plain public-CA verification.
    const supabase = /(^|\.)(supabase\.co|supabase\.com|pooler\.supabase\.com)$/.test(parsed.hostname);
    const tls = local ? false : supabase
      ? { rejectUnauthorized: true, ca: Bun.file(new URL('../../sql/supabase-ca.pem', import.meta.url)) }
      : { rejectUnauthorized: true };
    let db: SQL;
    try { db = new SQL(url!, { max: 5, connectionTimeout: 10, tls }); }
    catch { throw new Error('Invalid PostgreSQL connection configuration. Check DATABASE_URL.'); }
    const store = new GuildStore(db);
    try {
      await db`SELECT 1`;
      const rows: GuildRow[] = await db`SELECT guild_id, request_channel_id, panel_message_id, autoplay, sora_created FROM public.sora_guilds`;
      for (const row of rows) store.rows.set(row.guild_id, row);
      return store;
    } catch {
      await db.close();
      // Driver errors can contain connection details. Do not expose credentials in logs or Discord replies.
      throw new Error('PostgreSQL initialization failed. Check DATABASE_URL, TLS trust, connectivity, and sql/schema.sql.');
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
      ...(row.sora_created ? { channelOwned: true } : {}) };
  }

  entries(): Array<[string, GuildBinding]> {
    return [...this.rows.keys()].sort().flatMap(id => { const binding = this.get(id); return binding ? [[id, binding] as [string, GuildBinding]] : []; });
  }

  set(guildId: string, binding: GuildBinding) {
    return this.serial(guildId, async () => {
      try {
        const [row] = await this.db`INSERT INTO public.sora_guilds (guild_id, request_channel_id, panel_message_id, sora_created)
          VALUES (${guildId}, ${binding.requestChannelId}, ${binding.panelMessageId}, ${binding.channelOwned === true})
          ON CONFLICT (guild_id) DO UPDATE SET request_channel_id = EXCLUDED.request_channel_id,
          panel_message_id = EXCLUDED.panel_message_id, sora_created = EXCLUDED.sora_created RETURNING *`;
        this.rows.set(guildId, row);
      } catch { throw new Error('Unable to save guild settings. Please try again.'); }
    });
  }

  clear(guildId: string) {
    return this.serial(guildId, async () => {
      try {
        await this.db`DELETE FROM public.sora_guilds WHERE guild_id = ${guildId}`;
        this.rows.delete(guildId);
      } catch { throw new Error('Unable to clear guild settings. Please try again.'); }
    });
  }

  has(guildId: string) { return this.rows.get(guildId)?.autoplay === true; }

  toggleAutoplay(guildId: string) {
    return this.serial(guildId, async () => {
      try {
        const [row] = await this.db`INSERT INTO public.sora_guilds (guild_id, autoplay) VALUES (${guildId}, true)
          ON CONFLICT (guild_id) DO UPDATE SET autoplay = NOT sora_guilds.autoplay RETURNING *`;
        this.rows.set(guildId, row);
        return row.autoplay as boolean;
      } catch { throw new Error('Unable to save autoplay settings. Please try again.'); }
    });
  }

  async close() {
    await Promise.allSettled(this.pending.values());
    await this.db.close();
  }
}
