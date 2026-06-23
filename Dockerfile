FROM node:24.17.0-alpine3.24 AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Runtime stage: the Playwright base image bundles browsers + all system
# libraries Chrome needs, so the Meet bot can actually launch Chrome.
FROM mcr.microsoft.com/playwright:v1.59.1-jammy
# curl: HEALTHCHECK below + used by `n` to fetch Node. dumb-init: PID-1 init so the
# node process reaps the per-request stdio MCP servers + detached Chrome-joiner
# children and forwards SIGTERM (K8s graceful shutdown) instead of leaving zombies
# / ignoring the signal.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl dumb-init \
  && rm -rf /var/lib/apt/lists/*
# The Playwright base image ships a 24.x that predates the June 2026 Node security
# releases. Upgrade to 24.17.0 (same v24 line / ABI 137, so Playwright's prebuilt
# browsers and native bindings are unaffected) so the running process — not just the
# build — gets the CVE fixes. `n` installs into /usr/local/bin, which precedes the
# base image's /usr/bin/node on PATH; the version assertion fails the build otherwise.
RUN npm install -g n && n 24.17.0 && hash -r && node -v | grep -qx v24.17.0
WORKDIR /app
# pwuser's home — Playwright/Chrome resolves ~ to /home/pwuser for its profile.
ENV HOME=/home/pwuser
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
# Install Google Chrome stable for Playwright (joiner.ts uses channel: "chrome").
RUN npx playwright install --with-deps chrome
COPY --from=builder /app/dist ./dist
# Run as the non-root user that ships with the Playwright base image (pwuser,
# UID 1000). All root-requiring steps above (apt, global npm installs,
# npm ci, playwright/Chrome install, COPY) stay as root; only the runtime
# process drops privileges. Chrome is installed system-wide under
# /opt/google/chrome (world-readable/executable), so pwuser can launch it.
# Make /app — and especially the /app/data volume mount point where the
# persistent Chrome profile and meet-bot logs are written (the datastore now
# lives in ParadeDB, not on this volume) — owned by and writable for pwuser.
RUN mkdir -p /app/data && chown -R pwuser:pwuser /app
USER pwuser
VOLUME ["/app/data"]
EXPOSE 8930
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:8930/health || exit 1
# dumb-init as PID 1 → reaps subprocess zombies + forwards SIGTERM to node.
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/index.js"]
