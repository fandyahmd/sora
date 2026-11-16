# Sora

A Discord music bot with a persistent controller, live lyrics, autoplay, and per-guild setup — built on
[Bun](https://bun.sh), [Seyfert](https://seyfert.dev), [Hoshimi](https://hoshimi.js.org) and any
[Lavalink v4](https://lavalink.dev) node.

The controller is a Discord Components V2 card that lives in one channel and is edited in place: it shows
the current track with artwork, links, duration and requester, a karaoke lyric window, and playback
controls. Members request songs by simply typing a title or a URL into that channel.

Built by [Fan](https://github.com/fandyahmd). Self-host it, fork it, run it for your own server.

---

## Features

- **Persistent controller.** One card per guild, edited in place, restored after a restart. No message spam.
- **Live lyrics.** Fetched from [LRCLIB](https://lrclib.net) (free, no API key) and aligned to the audio by
  duration, so the sung line lights up as the singer starts it. Measured at −26 ms median against a real
  Discord panel, where the 224 ms round trip is the physical floor.
- **Autoplay.** When the queue ends, Sora keeps the music going from the last track.
- **Typed requests.** Members type a song title or URL into the request channel; their line is deleted and
  Sora's feedback self-destructs after five seconds.
- **Queue snapshot.** A private, read-only view of what is coming next.
- **Per-guild setup over slash commands.** Optional channel creation, and a clean teardown that only
  deletes a channel Sora itself created.
- **Health endpoint.** A small HTTP server (`/` and `/health`) so PaaS hosts keep the instance awake and
  you can point an uptime monitor at it.

Commands: `/setup-channel [channel]`, `/delete-channel`, `/play`, `/queue`, `/pause`, `/resume`, `/skip`,
`/stop`, `/autoplay`.

---

## Quick start

Requirements: [Bun](https://bun.sh) 1.4.4 or newer, a Supabase PostgreSQL database, and a Lavalink v4 node you are allowed to use.

```bash
bun install --frozen-lockfile
cp .env.example .env      # then fill it in — see Configuration below
bun run check             # typecheck
bun test                  # offline tests; PostgreSQL integration is opt-in
bun start
```

On first start the slash commands are uploaded globally and cached in `commands.json`.

### Discord application setup

1. Create an application at the [Discord Developer Portal](https://discord.com/developers/applications)
   and add a **Bot**.
2. Under **Bot → Privileged Gateway Intents**, enable **Message Content Intent**. Sora reads requests from
   a channel, so this intent is required.
3. Invite the bot with the `bot` and `applications.commands` scopes. The idle card shows an Invite link
   built from your own application id, so you can grab it from there once the bot is running.

Permissions Sora needs: View Channel, Send Messages, Read Message History, Embed Links, Manage Messages,
Attach Files, Connect, Speak, and Manage Channels if you want it to create the request channel itself.

---

## Configuration

Everything is environment variables. `.env.example` lists them all; the six without defaults are required.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DISCORD_TOKEN` | — | **Required.** Your bot token. |
| `LAVALINK_HOST` | — | **Required.** Node hostname, no scheme. |
| `LAVALINK_PORT` | — | **Required.** `443` for a secure node. |
| `LAVALINK_SECURE` | — | **Required.** `true` or `false`. |
| `LAVALINK_PASSWORD` | — | **Required.** The node's password. |
| `PORT` | `3000` | Health server port. Render and Koyeb inject their own. |
| `DATABASE_URL` | — | **Required.** PostgreSQL connection URL from Supabase. See *Persistence*. |
| `SUPPORT_INVITE_URL` | empty | Your own support server, shown on the idle card. Hidden when empty. |
| `INVITE_PERMISSIONS` | `8` | Permissions for the generated Invite link. |
| `REPOSITORY_URL` | `https://github.com` | Contact URL in the User-Agent sent to LRCLIB. |

Never commit `.env`. It is gitignored, and the bot reads credentials only from the environment.

### Persistence

Sora stores panel bindings, channel ownership and autoplay in `public.sora_guilds` using Bun's built-in
PostgreSQL driver. No additional dependency or persistent application disk is required.

1. Create a Supabase project and run [`sql/schema.sql`](sql/schema.sql) in its SQL editor. The script is
   rerunnable, enables RLS, and grants no access to `anon` or `authenticated`. Do not add public API
   policies for this table. The bot uses the PostgreSQL owner connection, which bypasses RLS.
2. Copy a PostgreSQL URL from **Connect** into the secret `DATABASE_URL` environment variable. Use the
   direct connection on port 5432 when the host supports IPv6. Supabase direct hosts are often IPv6-only;
   on IPv4-only hosts use the **Session pooler** URL (port 5432, user typically `postgres.<project-ref>`).
   Use session pooling, not the transaction pooler on port 6543, for the persistent bot connection.
3. URL-encode special characters in the database password. Never commit the URL or use a Supabase
   HTTP API key as a database password. Remote connections enforce TLS certificate and hostname
   validation even if the URL requests a weaker SSL mode; the bundled [`sql/supabase-ca.pem`](sql/supabase-ca.pem)
   is pinned automatically for `*.supabase.co` and `*.pooler.supabase.com` hosts, because Supabase serves
   its pooler behind a private CA that is not in the public trust store. Never disable certificate
   validation. Only loopback development connections use plaintext.
4. Start Sora. Missing configuration, unreachable PostgreSQL, invalid TLS, or a missing schema fails
   startup before Discord connects. Database URLs and raw database errors are not logged.

The cache hydrates before Discord starts. Mutations are awaited and update the cache only after SQL
succeeds; toggles use an atomic SQL upsert. Panel and lyric renders read the cache without network
queries. Run **one bot process per database**: another process or manual SQL edits will not refresh its
cache until restart. Queues, active playback and lyrics are still memory-only.

#### Optional SQLite migration

Stop the old bot and back up its SQLite file, including WAL files if the old process has not exited.
Apply the PostgreSQL schema and set `DATABASE_URL`, then run:

```bash
bun run migrate:sqlite /path/to/sora.sqlite
```

This explicit import reads SQLite without modifying or deleting it. It imports panel IDs, autoplay and
channel ownership in one PostgreSQL transaction. Pre-ownership schemas default to unowned channels.
Existing PostgreSQL guilds win (`ON CONFLICT DO NOTHING`), so rerunning is safe and never flips autoplay
or overwrites newer settings. Invalid source rows abort the import. Review the imported/skipped counts,
then start the new bot. Legacy JSON files are not imported; migrate those with the previous SQLite
release first. `DATABASE_PATH` is no longer used.

---

## Deploy

### Docker

```bash
docker build -t sora .
docker run -d --name sora --env-file .env -p 3000:3000 sora
```

The image is multi-stage: dependencies are resolved and typechecked in the builder, and the runtime stage
copies the result across, so the build touches the network in exactly one place. It runs as the
unprivileged `bun` user and declares a `HEALTHCHECK` against `/health`.

### Render

`render.yaml` in this repo is a ready blueprint — push the repo, then choose **New → Blueprint** in Render
and pick it. It creates a free Docker web service with `healthCheckPath: /health`.

A web service (rather than a worker) is deliberate: Render keeps a web service alive by its own health
check, and you can additionally point a free uptime monitor at `https://<your-service>.onrender.com/health`
to stop the free instance from spinning down when idle.

### Koyeb

Create a **Web** service from this repository, choose **Dockerfile** as the builder, set the port to `3000`
and add the environment variables. Koyeb's TCP health check uses the same port; `/health` is available if
you prefer an HTTP check.

### Keeping a free instance awake

Free tiers sleep an idle service and it takes a few seconds to wake, which a music bot cannot afford
mid-song. The health server exists for this. Point any free monitor (UptimeRobot, cron-job.org, a GitHub
Actions schedule) at `/health` every five minutes. Note that a sleeping host still drops the voice
connection: nothing can prevent that on a free tier, only make it rarer.

---

## How it works

```
src/index.ts              boot: health server, config, client, graceful shutdown
src/client.ts             Seyfert client extension + Hoshimi lifecycle wiring
src/config.ts             environment validation
src/commands/music/       slash commands (/play, /setup-channel, /delete-channel, …)
src/components/music.ts   persistent controller button handlers (no collectors)
src/events/               botReady initialization, raw voice packet bridge
src/services/health.ts    HTTP health / keep-alive server
src/services/channels.ts  the request channel: panel writer, cleanup, feedback
src/services/lyrics.ts    lyrics lookup (LRCLIB) and per-line scheduling
src/services/music.ts     playback: queueing, voice checks, per-guild serialization
src/services/db.ts        PostgreSQL store and hydrated cache, one row per guild
src/services/*.ts         request parsing, autocomplete cache, control actions
src/ui/                   pure renderers: cards, theme, sanitization
tests/                    offline tests with stub connections
```

Three details are worth knowing if you plan to change the code.

**The panel has exactly one writer, and it coalesces.** Discord allows a single message five edits per
five seconds and answers a sixth with `429`, which the HTTP layer then sleeps through *inside* the
request — so an un-coalesced burst (a skip fires three events at once) spends the whole budget on stale
payloads and leaves the panel seconds behind. Every event here only marks the panel as stale; one writer
draws once from the newest state, paced by a token bucket refilled at Discord's own rate.

**Lyrics are aligned by duration, not by title.** The same song exists on LRCLIB as a studio cut, an
official video with a spoken intro, a live take and a remix, each with its own timings. So the lookup
derives clean artist/title pairs from YouTube-shaped metadata, then asks LRCLIB for the exact
artist + title + duration, and rejects anything more than 15 s off the audio being played. Each line's
timer then fires about 250 ms early, because that is how long the edit takes to reach Discord.

**The controller is Components V2.** A payload cannot mix legacy fields (`content`, `embeds`) with
`MessageFlags.IsComponentsV2`, and a message created without the flag can never be patched into it. Sora
publishes a fresh panel instead of retrying such an edit, and treats a deleted message (`10008`) the same way.

---

## Verification

`bun test` runs offline tests for render states, requests, permissions, voice boundaries, serialization,
teardown, lyrics and configuration. Discord tests use an in-memory store; PostgreSQL integration is
skipped unless `TEST_DATABASE_URL` is explicitly provided. `bun run check` checks TypeScript.

Run the SQL integration test against an **isolated, disposable** local PostgreSQL database:

```bash
docker run --rm -d --name sora-pg-test -e POSTGRES_HOST_AUTH_METHOD=trust \
  -e POSTGRES_DB=sora_test -p 127.0.0.1:55432:5432 postgres:17-alpine
# Wait for: docker exec sora-pg-test pg_isready -U postgres
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/sora_test bun test
docker stop sora-pg-test
```

The integration test requires a loopback host and database named `sora_test`. It creates and drops
`public.sora_guilds`; never point it at real data. It verifies schema reruns/RLS, upserts, restart restore,
concurrent toggles within and across connections, teardown, failed-write cache safety, and idempotent
SQLite migration with an unchanged source file. It never reads `DATABASE_URL` for its test connection.

They do **not** verify a Discord login, the live voice handshake, or audible playback — those need a real
token, a real node and a real voice channel. No credentials or node addresses are bundled with this repo.

---

## Credits

- Lyrics from [LRCLIB](https://lrclib.net), a free and open lyrics database. Please keep a contact URL in
  `REPOSITORY_URL` so its operators can reach you if your usage is heavy.
- Framework: [Seyfert](https://seyfert.dev). Voice and queue: [Hoshimi](https://hoshimi.js.org).
  Node: [Lavalink](https://lavalink.dev).
- Runtime: [Bun](https://bun.sh).

## License

MIT — see [LICENSE](LICENSE).
