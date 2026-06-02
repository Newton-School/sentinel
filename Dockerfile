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
# curl is needed for the HEALTHCHECK below (Debian-based image).
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
# Install Google Chrome stable for Playwright (joiner.ts uses channel: "chrome").
RUN npx playwright install --with-deps chrome
COPY --from=builder /app/dist ./dist
VOLUME ["/app/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:8080/health || exit 1
CMD ["node", "dist/index.js"]
