import express from 'express';
import { logger } from '../../app/utils/logger';
import { attemptAutoLogin } from '../../infrastructure/logammulia/session-keepalive';
import { getConfig } from '../../app/config/env';

export interface WebhookPayload {
  trigger: string;
  timestamp?: string;
  location?: string;
  locationCode?: string;
  items?: { weight: string; qty: number }[];
}

interface TriggerResult {
  success: boolean;
  message: string;
  vaNumber?: string;
  elapsedMs: number;
}

type CheckoutHandler = (payload?: WebhookPayload) => Promise<TriggerResult>;

let _loginInProgress = false;

/**
 * Lightweight webhook server for receiving checkout triggers.
 *
 * Endpoints:
 * - GET  /health   - Health check (for Docker/monitoring)
 * - GET  /status   - Service status
 * - POST /checkout - Trigger checkout (accepts optional stock payload)
 * - GET  /auth     - Login form (for remote session refresh via Telegram link)
 * - POST /auth     - Trigger server-side login
 */
export function startWebhookServer(port: number, onCheckout: CheckoutHandler): void {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  app.get('/status', (_req, res) => {
    res.json({
      status: 'ready',
      service: 'lm-auto-checkout',
      mode: 'http-first',
      timestamp: new Date().toISOString(),
    });
  });

  // ── Remote login form ─────────────────────────────────────────────────────
  app.get('/auth', (_req, res) => {
    const config = getConfig();
    const hasSession = require('fs').existsSync(config.sessionFile);
    res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>LM Auto-Checkout - Login</title>
<style>
  body{font-family:system-ui;max-width:400px;margin:40px auto;padding:0 20px;background:#f5f5f5}
  .card{background:#fff;padding:24px;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,.1)}
  h2{margin:0 0 16px;color:#333}
  .status{padding:8px 12px;border-radius:6px;margin-bottom:16px;font-size:14px}
  .ok{background:#e8f5e9;color:#2e7d32}
  .expired{background:#fbe9e7;color:#c62828}
  label{display:block;margin:12px 0 4px;font-weight:500;font-size:14px}
  input{width:100%;padding:10px;border:1px solid #ddd;border-radius:6px;box-sizing:border-box;font-size:16px}
  button{width:100%;padding:12px;background:#1976d2;color:#fff;border:none;border-radius:6px;font-size:16px;cursor:pointer;margin-top:16px}
  button:hover{background:#1565c0}
  button:disabled{background:#999;cursor:not-allowed}
  .note{font-size:12px;color:#666;margin-top:12px}
</style></head><body>
<div class="card">
  <h2>🔐 Login Logam Mulia</h2>
  <div class="status ${hasSession ? 'ok' : 'expired'}">
    Session: ${hasSession ? '✅ Active' : '❌ Expired / Not Found'}
  </div>
  <form method="POST" action="/auth" id="loginForm">
    <label>Email</label>
    <input type="email" name="email" value="${config.lmEmail || ''}" required>
    <label>Password</label>
    <input type="password" name="password" value="${config.lmPassword || ''}" required>
    <button type="submit" id="btn">Login (Server-side)</button>
  </form>
  <p class="note">Server akan login otomatis menggunakan DrissionPage + captcha bypass. Proses memakan waktu 30-60 detik.</p>
</div>
<script>
document.getElementById('loginForm').onsubmit=function(){
  document.getElementById('btn').disabled=true;
  document.getElementById('btn').textContent='⏳ Logging in...';
};
</script>
</body></html>`);
  });

  app.post('/auth', async (req, res) => {
    if (_loginInProgress) {
      res.send('<html><body><h2>⏳ Login sedang berjalan...</h2><p>Tunggu sebentar lalu refresh halaman.</p></body></html>');
      return;
    }

    _loginInProgress = true;
    const { email, password } = req.body as { email?: string; password?: string };
    const config = getConfig();

    // Override credentials if provided via form
    if (email) (config as any).lmEmail = email;
    if (password) (config as any).lmPassword = password;

    logger.info('[Auth-Web] Remote login triggered via /auth form');

    try {
      const success = await attemptAutoLogin(config);
      _loginInProgress = false;

      if (success) {
        logger.info('[Auth-Web] ✓ Remote login successful');
        res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:system-ui;max-width:400px;margin:40px auto;padding:0 20px;text-align:center}</style>
</head><body>
<h2>✅ Login Berhasil!</h2>
<p>Session telah diperbarui. Auto-checkout siap digunakan.</p>
<p><a href="/auth">← Kembali</a></p>
</body></html>`);
      } else {
        logger.warn('[Auth-Web] ✗ Remote login failed');
        res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:system-ui;max-width:400px;margin:40px auto;padding:0 20px;text-align:center}</style>
</head><body>
<h2>❌ Login Gagal</h2>
<p>Captcha tidak bisa di-solve otomatis dari server ini. Coba lagi atau upload session manual.</p>
<p><a href="/auth">← Coba Lagi</a></p>
</body></html>`);
      }
    } catch (err) {
      _loginInProgress = false;
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`[Auth-Web] Error: ${msg}`);
      res.status(500).send(`<h2>Error</h2><p>${msg}</p><p><a href="/auth">← Kembali</a></p>`);
    }
  });

  // ── Checkout trigger ──────────────────────────────────────────────────────
  app.post('/checkout', async (req, res) => {
    const payload = req.body as WebhookPayload | undefined;
    logger.info(
      `[Webhook] Checkout triggered${payload?.location ? ` (location: ${payload.location})` : ''}`,
    );

    try {
      const result = await onCheckout(payload);

      if (result.success) {
        logger.info(`[Webhook] ✓ ${result.message} (${result.elapsedMs}ms)`);
        res.json({
          success: true,
          message: result.message,
          vaNumber: result.vaNumber,
          elapsedMs: result.elapsedMs,
          timestamp: new Date().toISOString(),
        });
      } else {
        logger.warn(`[Webhook] ✗ ${result.message} (${result.elapsedMs}ms)`);
        res.status(400).json({
          success: false,
          error: result.message,
          elapsedMs: result.elapsedMs,
          timestamp: new Date().toISOString(),
        });
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error(`[Webhook] Error: ${errorMessage}`);
      res.status(500).json({
        success: false,
        error: errorMessage,
        timestamp: new Date().toISOString(),
      });
    }
  });

  app.listen(port, () => {
    logger.info(`[Webhook] Server listening on port ${port}`);
  });
}
