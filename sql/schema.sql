-- Run once in the Supabase SQL editor as the database owner before starting Sora.
-- Rerunnable; application connections never need DDL permissions.
CREATE TABLE IF NOT EXISTS public.sora_guilds (
  guild_id TEXT PRIMARY KEY CHECK (length(guild_id) > 0),
  request_channel_id TEXT,
  panel_message_id TEXT,
  autoplay BOOLEAN NOT NULL DEFAULT false,
  sora_created BOOLEAN NOT NULL DEFAULT false,
  CHECK ((request_channel_id IS NULL) = (panel_message_id IS NULL)),
  CHECK (request_channel_id IS NULL OR length(request_channel_id) > 0),
  CHECK (panel_message_id IS NULL OR length(panel_message_id) > 0)
);

ALTER TABLE public.sora_guilds ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sora_guilds FROM PUBLIC;
-- No API policies: anon/authenticated clients cannot read or mutate guild data.
-- Supabase's postgres owner bypasses RLS for the bot's PostgreSQL connection.
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON public.sora_guilds FROM anon;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON public.sora_guilds FROM authenticated;
  END IF;
END $$;
