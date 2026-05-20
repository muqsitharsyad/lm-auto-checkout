# Playwright base (Node + Chromium browsers + system deps preinstalled)
FROM mcr.microsoft.com/playwright:v1.44.0-jammy

WORKDIR /app

# ── Python + ffmpeg for the captcha solver / DrissionPage login ──────────────
# DrissionPage drives Chromium directly — we install python3 alongside the
# Playwright image (Node ecosystem) so the auto-login fallback works without
# a separate sidecar container.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3 python3-pip ffmpeg \
 && rm -rf /var/lib/apt/lists/*

# Symlink so /usr/bin/python resolves (Python script uses `python`, not `python3`)
RUN ln -sf /usr/bin/python3 /usr/bin/python

# ── Node deps ────────────────────────────────────────────────────────────────
COPY package*.json ./
RUN npm ci

# ── Python deps (from scripts/requirements.txt) ──────────────────────────────
COPY scripts/requirements.txt ./scripts/requirements.txt
RUN pip3 install --no-cache-dir --break-system-packages -r scripts/requirements.txt

# ── Source + scripts ─────────────────────────────────────────────────────────
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

# Compile TypeScript
RUN npm run build

# ── Trusted Chromium profile for reCAPTCHA bypass ────────────────────────────
# Bot profile (cookies + history + state) gives Google enough trust signal that
# the reCAPTCHA checkbox auto-passes without any audio challenge. Without this
# the login flow stalls on captcha. The profile is bundled into the image so
# the container is self-contained — `~/.antam_bot_profile` inside the container
# is the path Python script defaults to.
COPY .bot_profile /root/.antam_bot_profile

# Ensure data directories exist (volume-mounted at runtime for persistence)
RUN mkdir -p data/debug

# Run the main service (webhook server + session keepalive + auto-login)
CMD ["node", "dist/interfaces/cli/index.js"]
