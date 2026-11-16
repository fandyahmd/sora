# Sora — Bun + Seyfert + Hoshimi (Lavalink v4) music bot.
#
# Match the user's working Soundy base image. Sora's tests pass on this version locally;
# deployment on Render still needs verification. The cause of earlier DNS failures is not established.
FROM oven/bun:1.2.0
WORKDIR /app
ENV NODE_ENV=production

COPY --chown=bun:bun package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY --chown=bun:bun seyfert.config.mjs ./
COPY --chown=bun:bun src ./src
COPY --chown=bun:bun sql ./sql
COPY --chown=bun:bun assets ./assets

# The bot writes commands.json (and the SQLite cache if used) beside the code, so the app dir must be
# writable by the unprivileged user.
RUN chown -R bun:bun /app
USER bun

ENV PORT=3000
EXPOSE 3000

# The Debian image has no wget/curl, so the probe uses bun itself.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e "const r = await fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health'); process.exit(r.ok ? 0 : 1)"

CMD ["bun", "src/index.ts"]
