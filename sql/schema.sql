-- Sora guild state, SQLite dialect (Turso / libSQL).
--
-- The bot runs this automatically on startup, so a manual step is optional. It is a single idempotent
-- statement: rerunning it never loses data. Turso has no row-level security (unlike Supabase); access is
-- governed entirely by the TURSO_AUTH_TOKEN, which grants full read/write to this database.
CREATE TABLE IF NOT EXISTS sora_guilds (
  guild_id           TEXT PRIMARY KEY CHECK (length(guild_id) > 0),
  request_channel_id TEXT,
  panel_message_id   TEXT,
  autoplay           INTEGER NOT NULL DEFAULT 0 CHECK (autoplay IN (0, 1)),
  sora_created       INTEGER NOT NULL DEFAULT 0 CHECK (sora_created IN (0, 1)),
  CHECK ((request_channel_id IS NULL) = (panel_message_id IS NULL)),
  CHECK (request_channel_id IS NULL OR length(request_channel_id) > 0),
  CHECK (panel_message_id IS NULL OR length(panel_message_id) > 0)
);
