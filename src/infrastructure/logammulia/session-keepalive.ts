import axios from "axios";
import { CookieJar } from "tough-cookie";
import { wrapper } from "axios-cookiejar-support";
import { execFile } from "child_process";
import fs from "fs/promises";
import path from "path";
import { AppConfig } from "../../app/config/env";
import { logger } from "../../app/utils/logger";

const BASE_URL = "https://www.logammulia.com";
const MY_ACCOUNT_URL = `${BASE_URL}/id/my-account`;
const PYTHON_LOGIN_SCRIPT = path.resolve(__dirname, "../../../scripts/python_login.py");

/**
 * Pings /id/my-account to keep the session alive.
 * Returns true if session is still valid, false if expired.
 */
export async function keepSessionAlive(sessionFile: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(sessionFile, "utf-8");
    const sessionData = JSON.parse(raw);

    const jar = new CookieJar();
    for (const c of sessionData.cookies || []) {
      try {
        const cleanDomain = (c.domain || "").replace(/^\./, "");
        const cookieStr = `${c.name}=${c.value}; Domain=${cleanDomain}; Path=${c.path || "/"}`;
        const url = `https://${cleanDomain}${c.path || "/"}`;
        jar.setCookieSync(cookieStr, url);
      } catch {
        // skip invalid cookies
      }
    }

    const client = wrapper(
      axios.create({
        jar,
        withCredentials: true,
        timeout: 15_000,
        maxRedirects: 0,
        validateStatus: () => true,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        },
      }),
    );

    const resp = await client.get(MY_ACCOUNT_URL);

    const isExpired =
      resp.status === 302 ||
      resp.status === 301 ||
      (resp.headers.location && resp.headers.location.includes("/login")) ||
      (typeof resp.data === "string" && resp.data.includes('action="/id/login"'));

    if (isExpired) {
      logger.warn("[Keepalive] Session expired");
      return false;
    }

    logger.info("[Keepalive] Session alive ✓");
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`[Keepalive] Check failed: ${msg}`);
    return false;
  }
}

/**
 * Attempts auto-login by spawning the Python script (DrissionPage + reCAPTCHA bypass).
 * The Python script writes a Playwright-compatible session.json on success.
 *
 * Why Python: Playwright + stealth plugin can't reliably pass Google reCAPTCHA in
 * headless mode. DrissionPage with persistent profile + comprehensive anti-detection
 * JS (proven approach from the antam-new project) lets the checkbox auto-pass on
 * trusted sessions, and falls back to audio STT when a challenge appears.
 */
export async function attemptAutoLogin(config: AppConfig): Promise<boolean> {
  if (!config.lmEmail || !config.lmPassword) {
    logger.error("[AutoLogin] LM_EMAIL/LM_PASSWORD not set in env");
    return false;
  }

  logger.info("[AutoLogin] Spawning Python login script...");
  const start = Date.now();

  return new Promise<boolean>((resolve) => {
    const args = [
      PYTHON_LOGIN_SCRIPT,
      "--session-out",
      config.sessionFile,
    ];
    // Always run non-headless (better captcha pass rate). On Linux servers without
    // a display, we wrap with xvfb-run to provide a virtual framebuffer.
    // On Windows (local dev), DrissionPage positions the window off-screen.

    const isLinux = process.platform === "linux";
    const command = isLinux ? "xvfb-run" : "python";
    const fullArgs = isLinux
      ? ["--auto-servernum", "--server-args=-screen 0 1366x768x24", "python", ...args]
      : args;

    const proc = execFile(
      command,
      fullArgs,
      {
        timeout: 180_000,
        env: {
          ...process.env,
          LM_EMAIL: config.lmEmail,
          LM_PASSWORD: config.lmPassword,
        },
      },
      (error, stdout, stderr) => {
        const elapsed = Date.now() - start;
        if (stderr) {
          // Python script writes progress logs to stderr — surface them as info
          for (const line of stderr.split("\n")) {
            if (line.trim()) logger.info(`[Python] ${line}`);
          }
        }
        if (stdout && stdout.trim()) {
          logger.info(`[Python:stdout] ${stdout.trim()}`);
        }
        if (error) {
          logger.error(`[AutoLogin] Failed after ${elapsed}ms: ${error.message}`);
          resolve(false);
          return;
        }
        logger.info(`[AutoLogin] ✓ Python login succeeded (${elapsed}ms)`);
        resolve(true);
      },
    );

    proc.on("error", (err) => {
      logger.error("[AutoLogin] Python spawn failed:", err);
      resolve(false);
    });
  });
}

/** Returns current WIB hour (0-23). */
function nowWibHour(): number {
  const wib = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Jakarta" }));
  return wib.getHours();
}

/** Returns current WIB minutes from midnight. */
function nowWibMinutes(): number {
  const wib = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Jakarta" }));
  return wib.getHours() * 60 + wib.getMinutes();
}

/** Check if current time is within auto-login window (06:50 - 17:00 WIB). */
function isInAutoLoginWindow(): boolean {
  const mins = nowWibMinutes();
  return mins >= 6 * 60 + 50 && mins < 17 * 60;
}

/**
 * Starts the full keepalive + auto-login system:
 * - Ping session every 5 minutes
 * - If expired AND within 11:50-17:00 WIB → auto-login (3 retries)
 * - If expired outside window → Telegram alert only
 * - Pre-login at 11:50 WIB to ensure fresh session before ekspedisi hours
 */
export function startKeepaliveLoop(
  config: AppConfig,
  onExpired: () => void | Promise<void>,
  intervalMs = 5 * 60 * 1000,
): () => void {
  let alerted = false;
  let preLoginDoneToday = false;
  let lastPreLoginDate = "";

  const timer = setInterval(async () => {
    // Pre-login at 06:50 WIB (once per day)
    const today = new Date().toISOString().slice(0, 10);
    const mins = nowWibMinutes();
    if (mins >= 6 * 60 + 50 && mins < 6 * 60 + 55 && lastPreLoginDate !== today) {
      lastPreLoginDate = today;
      logger.info("[Keepalive] Pre-login scheduled (06:50 WIB) — refreshing session...");
      const success = await attemptAutoLogin(config);
      if (success) {
        logger.info("[Keepalive] ✓ Pre-login successful");
        alerted = false;
        return;
      }
      logger.warn("[Keepalive] Pre-login failed — will alert");
    }

    // Regular keepalive check
    const alive = await keepSessionAlive(config.sessionFile);

    if (!alive) {
      if (isInAutoLoginWindow()) {
        logger.info("[Keepalive] Session expired in active window — attempting auto-login...");
        let success = false;
        for (let attempt = 1; attempt <= 3; attempt++) {
          logger.info(`[Keepalive] Auto-login attempt ${attempt}/3...`);
          success = await attemptAutoLogin(config);
          if (success) {
            logger.info(`[Keepalive] ✓ Auto-login succeeded on attempt ${attempt}`);
            alerted = false;
            break;
          }
          // Wait 5s between retries
          await new Promise((r) => setTimeout(r, 5_000));
        }
        if (!success && !alerted) {
          alerted = true;
          logger.warn("[Keepalive] All auto-login attempts failed — sending alert");
          await Promise.resolve(onExpired()).catch(() => {});
        }
      } else if (!alerted) {
        alerted = true;
        logger.warn("[Keepalive] Session expired outside active window — sending alert");
        await Promise.resolve(onExpired()).catch(() => {});
      }
    } else {
      alerted = false;
    }
  }, intervalMs);

  return () => clearInterval(timer);
}
