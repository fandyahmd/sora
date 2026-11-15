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

Requirements: [Bun](https://bun.sh) 1.3 or newer, and a Lavalink v4 node you are allowed to use.

```bash
bun install --frozen-lockfile
cp .env.example .env      # then fill it in — see Configuration below
bun run check             # typecheck
bun test                  # 40 offline tests
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

Everything is environment variables. `.env.example` lists them all; the five without defaults are required.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DISCORD_TOKEN` | — | **Required.** Your bot token. |
| `LAVALINK_HOST` | — | **Required.** Node hostname, no scheme. |
| `LAVALINK_PORT` | — | **Required.** `443` for a secure node. |
| `LAVALINK_SECURE` | — | **Required.** `true` or `false`. |
| `LAVALINK_PASSWORD` | — | **Required.** The node's password. |
| `PORT` | `3000` | Health server port. Render and Koyeb inject their own. |
| `DATABASE_PATH` | `./data/sora.sqlite` | Where per-guild state is stored. See *Persistence*. |
| `SUPPORT_INVITE_URL` | empty | Your own support server, shown on the idle card. Hidden when empty. |
| `INVITE_PERMISSIONS` | `8` | Permissions for the generated Invite link. |
| `REPOSITORY_URL` | `https://github.com` | Contact URL in the User-Agent sent to LRCLIB. |

Never commit `.env`. It is gitignored, and the bot reads credentials only from the environment.

### Persistence

Sora stores per-guild state (the panel binding and the autoplay switch) in one SQLite file via `bun:sqlite`,
so there is no database to run.

On a host with an **ephemeral filesystem** — Render's free tier and Koyeb's free instance both qualify —
that file disappears on every deploy, and each guild has to run `/setup-channel` again. Point
`DATABASE_PATH` at a mounted disk or volume to keep it. On Render that means adding a Disk in the
dashboard and setting `DATABASE_PATH` to its mount path (for example `/var/sora/sora.sqlite`); disks are a
paid feature, so on the free tier expect to re-run setup after a deploy that recreates the instance.

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
src/services/db.ts        SQLite store: panel binding + autoplay, one row per guild
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

`bun test` runs 40 offline tests: cache isolation and expiry, SQLite persistence and the legacy-JSON
import, panel render states and reuse, request filtering, permission checks, voice boundaries, per-guild
serialization, teardown, lyric parsing and scheduling, and Bun module loading.

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
