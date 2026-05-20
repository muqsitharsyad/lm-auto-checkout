# Playwright base (Node + Chromium browsers + system deps preinstalled)
FROM mcr.microsoft.com/playwright:v1.44.0-jammy

WORKDIR /app

# ── Python + ffmpeg + Google Chrome for the captcha solver / DrissionPage ────
# DrissionPage drives Chrome directly. The Playwright base image bundles
# Chromium at a non-standard path, which DrissionPage can't auto-detect, so
# we install Google Chrome stable separately to get /usr/bin/google-chrome
# (and a `google-chrome-stable` shim DrissionPage finds via PATH).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3 python3-pip ffmpeg wget gnupg ca-certificates \
 && wget -q -O- https://dl.google.com/linux/linux_signing_key.pub \
      | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
 && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" \
      > /etc/apt/sources.list.d/google-chrome.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends google-chrome-stable \
 && rm -rf /var/lib/apt/lists/*

# Symlink so /usr/bin/python resolves (Python script uses `python`, not `python3`)
# and DrissionPage finds `chrome` (it tries the bare name on PATH first).
RUN ln -sf /usr/bin/python3 /usr/bin/python \
 && ln -sf /usr/bin/google-chrome-stable /usr/bin/chrome

# ── Node deps ────────────────────────────────────────────────────────────────
COPY package*.json ./
RUN npm ci

# ── Python deps (from scripts/requirements.txt) ──────────────────────────────
COPY scripts/requirements.txt ./scripts/requirements.txt
RUN pip3 install --no-cache-dir -r scripts/requirements.txt

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
