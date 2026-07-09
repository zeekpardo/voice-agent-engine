# syntax=docker/dockerfile:1
ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-slim AS base

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV HOME="/app"

# ca-certificates: the LiveKit SDK's native core reads the system trust store,
# which the slim base image doesn't ship.
RUN apt-get update -qq && apt-get install --no-install-recommends -y ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@10

FROM base AS build
WORKDIR /app
COPY package.json ./
RUN pnpm install
# Pre-download ML model files (turn detector) so cold starts don't fetch them.
RUN npx livekit-agents download-files || true
COPY . .

FROM base
ARG UID=10001
RUN adduser --disabled-password --gecos "" --home "/app" --shell "/sbin/nologin" --uid "${UID}" appuser
WORKDIR /app
COPY --from=build --chown=appuser:appuser /app /app
USER appuser
ENV NODE_ENV=production
CMD [ "pnpm", "start" ]
