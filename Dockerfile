# voice-gateway — Railway/Docker image
FROM node:22-bookworm-slim

# System deps:
#  - ffmpeg: audio extraction from video/uploads
#  - yt-dlp (standalone linux binary): URL/YouTube audio fetch
#  - build-essential/python3: fallback compile for better-sqlite3 native module
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg ca-certificates curl python3 build-essential \
  && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux \
       -o /usr/local/bin/yt-dlp \
  && chmod a+rx /usr/local/bin/yt-dlp \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@11.3.0 --activate

WORKDIR /app
COPY . .

# Install without lifecycle scripts (pnpm 11 blocks native builds and treats it as
# fatal), then explicitly fetch better-sqlite3's prebuilt native binary for linux.
RUN pnpm install --frozen-lockfile --ignore-scripts \
 && PKG="$(node -e "console.log(require('path').dirname(require.resolve('better-sqlite3/package.json')))")" \
 && ( cd "$PKG" && npx --yes prebuild-install --tag-prefix v || npm run build-release ) \
 && node -e "const D=require('better-sqlite3'); new D(':memory:').prepare('select 1').get(); console.log('sqlite native binding OK')"

# App reads PORT from env (Railway injects it); listens on all interfaces.
ENV NODE_ENV=production
CMD ["pnpm", "start"]
