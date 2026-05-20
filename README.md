# Logam Mulia Auto Checkout

Automated checkout service for Logam Mulia gold purchases with Telegram VA notifications.

## Architecture

Uses **Playwright (browser automation)** because:
- Purchase page renders stock via JavaScript (not in raw HTML)
- Login requires reCAPTCHA solving
- Session cookies are tied to browser context

Speed optimizations:
- Block images, fonts, analytics (saves ~500ms per page load)
- Use `domcontentloaded` instead of `networkidle`
- Pre-loaded session, browser always ready
- Minimal waits between steps

## Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│  PHASE 1: LOGIN (one-time, manual captcha)                          │
│  npm run dev:login                                                  │
│  → Browser opens, solve captcha, session saved                      │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│  PHASE 2: SERVICE RUNNING (npm run dev)                             │
│  → Session maintained, webhook listening                            │
│  → Browser standby on purchase page                                 │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼ (POST /checkout from stock-scheduler)
┌─────────────────────────────────────────────────────────────────────┐
│  PHASE 3: AUTO CHECKOUT (~3-5 seconds)                              │
│  /purchase/gold → Set qty=1 for available items → Submit            │
│        ↓                                                            │
│  /my-cart → Click Checkout                                          │
│        ↓                                                            │
│  /checkout → Paxel + VA Mandiri + Agree → Bayar                     │
│        ↓                                                            │
│  Confirmation → Extract VA → Telegram notification                  │
└─────────────────────────────────────────────────────────────────────┘
```

## Setup

1. **Install dependencies**
   ```bash
   npm install
   npx playwright install chromium
   ```

2. **Configure environment**
   ```bash
   cp .env.example .env
   # Edit .env with your credentials
   ```

3. **Login (one-time)**
   ```bash
   npm run dev:login
   ```
   Browser opens → solve captcha → session saved automatically.

4. **Start service**
   ```bash
   npm run dev
   ```

## Commands

| Command | Description |
|---------|-------------|
| `npm run dev:login` | Login and save session |
| `npm run dev:checkout` | Test checkout (no Telegram) |
| `npm run dev` | Start service with webhook |

## Webhook API

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check |
| GET | `/status` | Service status |
| POST | `/checkout` | Trigger checkout |

## Integration with stock-scheduler

In `lm-stock-scheduler`, trigger checkout when stock detected:
```typescript
await fetch('http://localhost:3300/checkout', { method: 'POST' });
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `LM_EMAIL` | Yes | - | Account email |
| `LM_PASSWORD` | Yes | - | Account password |
| `TELEGRAM_BOT_TOKEN` | Yes | - | Telegram bot token |
| `TELEGRAM_CHAT_ID` | Yes | - | Telegram chat ID |
| `TARGET_WEIGHTS` | No | `0.5,1,2,3` | Gramasi to checkout |
| `WEBHOOK_PORT` | No | `3300` | Webhook port |
| `HEADLESS` | No | `false` | Browser headless mode |
| `WIT_AI_ACCESS_TOKEN` | No | - | Wit.ai for auto captcha |
