FROM node:20-bookworm-slim AS base

# Prevent Puppeteer from downloading Chromium (we'll use system Chromium)
ENV PUPPETEER_SKIP_DOWNLOAD=true

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    curl \
    ca-certificates \
    fonts-liberation \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libnss3 \
    libxss1 \
    libasound2 \
    libgbm1 \
    libxshmfence1 \
    libx11-xcb1 \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    APP_DATA_DIR=/data \
    OUTPUT_DIR=/data

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application code
COPY . .

# Create and own data directory for configs and outputs
RUN mkdir -p /data && chown -R node:node /data /app

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --retries=5 CMD curl -fsS http://localhost:3000/ || exit 1

CMD ["node", "server.js"]


