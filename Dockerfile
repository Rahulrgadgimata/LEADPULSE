# LeadPulse AI — Node API + frontend + Scrapling (Python) sidecar
FROM node:20-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip \
    chromium \
    fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0 libcups2 \
    libdbus-1-3 libdrm2 libgbm1 libgtk-3-0 libnspr4 libnss3 libx11-xcb1 \
    libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libxss1 libxtst6 \
    ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Declared before `npm install` so puppeteer skips its own ~170MB Chromium
# download and uses the apt one above. Setting these later still works at
# runtime but pays for the download on every build.
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

COPY backend/package.json backend/package-lock.json* ./backend/
RUN cd backend && npm install --omit=dev

COPY backend/scrapling/requirements.txt ./backend/scrapling/
RUN pip3 install --break-system-packages -r backend/scrapling/requirements.txt \
    && scrapling install || true

COPY backend ./backend
COPY frontend ./frontend
COPY scripts/start.sh /start.sh
RUN chmod +x /start.sh

WORKDIR /app/backend

ENV NODE_ENV=production
ENV PORT=3000
ENV TRUST_PROXY=true
ENV SCRAPLING_PYTHON=python3
ENV SCRAPLING_HOST=127.0.0.1
ENV SCRAPLING_PORT=3765
# /var/data is where Render mounts a persistent disk. Without a disk attached
# the path still works, but the file lives in the container's own filesystem and
# is discarded on every restart or deploy.
ENV SQLITE_PATH=/var/data/database.sqlite

EXPOSE 3000

CMD ["/start.sh"]
