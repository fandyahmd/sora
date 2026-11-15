# Sora — Bun + Seyfert + Hoshimi (Lavalink v4) music bot.
#
# Two stages. The builder resolves dependencies once and typechecks, the runtime stage copies the
# finished /app across — no second `bun install`, so the image build needs the network in exactly one
# place and a registry blip cannot break the runtime half.
#
# ponytail: dev dependencies ride along in the final image (typescript, @types). ~30 MB against a much
# simpler, more reliable build; strip them with a `bun prune` step if image size ever matters.
FROM oven/bun:1.4.4-alpine AS builder
WORKDIR /app

# Install with a frozen lockfile first, so a dependency change invalidates only this layer.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY tsconfig.json seyfert.config.mjs ./
COPY src ./src
COPY tests ./tests
# Fail the image build on a type error rather than at boot.
RUN bunx tsc --noEmit

FROM oven/bun:1.4.4-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src ./src
COPY --from=builder /app/package.json ./
COPY seyfert.config.mjs ./
# The idle banner is read at runtime, so it must be in the image.
COPY assets ./assets

# Run as the unprivileged user the base image ships, and keep the app directory writable so the SQLite
# file and the command cache can be created next to the code.
RUN mkdir -p /app/data && chown -R bun:bun /app
USER bun

ENV PORT=3000 \
    DATABASE_PATH=/app/data/sora.sqlite

EXPOSE 3000

# Koyeb, Docker and Compose use this to decide the service is alive.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1 || exit 1

CMD ["bun", "src/index.ts"]
