FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Runtime stage: the Playwright base image bundles browsers + all system
# libraries Chrome needs, so the Meet bot can actually launch Chrome.
FROM mcr.microsoft.com/playwright:v1.59.1-jammy
RUN npm install -g @anthropic-ai/claude-code
# curl: HEALTHCHECK below. dumb-init: PID-1 init so the node process reaps the
# claude CLI / MCP / detached Chrome-joiner children and forwards SIGTERM
# (K8s graceful shutdown) instead of leaving zombies / ignoring the signal.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl dumb-init \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# pwuser's home — the Claude CLI reads its login from $HOME/.claude (mounted as
# a Secret in K8s). Make it explicit so the runtime resolves ~ to /home/pwuser.
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
# SQLite DB, persistent Chrome profile, and meet-bot logs are written —
# owned by and writable for pwuser.
RUN mkdir -p /app/data && chown -R pwuser:pwuser /app
USER pwuser
VOLUME ["/app/data"]
EXPOSE 8930
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:8930/health || exit 1
# dumb-init as PID 1 → reaps subprocess zombies + forwards SIGTERM to node.
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/index.js"]
