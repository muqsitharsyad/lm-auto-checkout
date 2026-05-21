/**
 * Main entry: webhook server + checkout.
 *
 * Strategy: HTTP-first checkout (target <10s).
 *  - Webhook receives stock-available trigger from lm-stock-scheduler
 *  - Pure HTTP path runs immediately (no Playwright startup cost)
 *  - Playwright only spun up lazily when:
 *      a. session expires → re-login needed, or
 *      b. HTTP path fails and Playwright fallback is required
 *
 * This keeps the service idle-cost near zero and gives the fastest possible
 * VA-number turnaround when stock actually appears.
 *
 * Usage: npm run dev
 */

import { getConfig } from "../../app/config/env";
import { logger } from "../../app/utils/logger";
import {
  closeBrowser,
  getContext,
  getPage,
  warmupBrowser,
  startPageRefreshLoop,
} from "../../infrastructure/browser/playwright-client";
import {
  performHttpCheckout,
  StockPayload,
} from "../../infrastructure/logammulia/http-checkout-client";
import {
  sendCheckoutNotification,
  sendCheckoutFailureNotification,
  sendSessionExpiredAlert,
} from "../../infrastructure/telegram/telegram-client";
import { performCheckoutFast } from "../../application/use-cases/perform-checkout-fast";
import { startWebhookServer, WebhookPayload } from "../webhook/server";
import { fileExists } from "../../app/utils/file";
import { startKeepaliveLoop } from "../../infrastructure/logammulia/session-keepalive";

interface TriggerResult {
  success: boolean;
  message: string;
  vaNumber?: string;
  elapsedMs: number;
}

let isCheckoutInProgress = false;
/**
 * Tracks the last successfully bought (location|weight) combinations.
 * Stock-scheduler is responsible for only firing webhook on 0→>0 transitions
 * and enforcing per-item cooldown. So here we only block re-buying the SAME
 * item we just bought — same item is allowed again after the scheduler signals
 * stock came back (which it only does after stock dropped to 0 first).
 *
 * Key: `${locationCode}|${weight}` → timestamp of last successful checkout.
 * Cleared after `RECENT_PURCHASE_TTL_MS` so a stale entry never blocks a real
 * new opportunity hours later.
 */
const recentPurchases = new Map<string, number>();
const RECENT_PURCHASE_TTL_MS = 5 * 60 * 1000;

function recordPurchase(payload?: WebhookPayload): void {
  if (!payload?.items || !payload.items.length) return;
  const locKey = payload.locationCode ?? payload.location ?? "unknown";
  const now = Date.now();
  for (const item of payload.items) {
    recentPurchases.set(`${locKey}|${item.weight}`, now);
  }
}

/**
 * Webhook handler. Optimized path:
 *  1. Quick guards (in-progress, cooldown)
 *  2. HTTP checkout (no Playwright touched)
 *  3. If HTTP signals "session expired" → escalate to performCheckoutFast
 *     which boots Playwright, re-logs in, refreshes session, retries HTTP.
 */
async function handleCheckoutTrigger(
  payload?: WebhookPayload,
): Promise<TriggerResult> {
  const triggerStart = Date.now();
  const config = getConfig();

  if (isCheckoutInProgress) {
    return {
      success: false,
      message: "Checkout already in progress",
      elapsedMs: Date.now() - triggerStart,
    };
  }

  // Per-item dedup: reject if we just successfully bought the SAME (location|weight)
  // within the TTL. Scheduler is responsible for only firing webhook on 0→>0 transitions,
  // so a request for the same item soon after success is almost certainly a stale retry.
  // After TTL expires, we trust the scheduler again (it only fires when stock came back).
  if (payload?.items && payload.items.length > 0) {
    const locKey = payload.locationCode ?? payload.location ?? "unknown";
    const now = Date.now();
    const stale = payload.items.find((i) => {
      const key = `${locKey}|${i.weight}`;
      const lastBoughtAt = recentPurchases.get(key);
      if (lastBoughtAt && now - lastBoughtAt < RECENT_PURCHASE_TTL_MS) {
        return true;
      }
      // Auto-clean expired entries
      if (lastBoughtAt) recentPurchases.delete(key);
      return false;
    });
    if (stale) {
      const secondsLeft = Math.ceil(
        (RECENT_PURCHASE_TTL_MS - (now - (recentPurchases.get(`${locKey}|${stale.weight}`) ?? 0))) / 1000,
      );
      return {
        success: false,
        message: `Just purchased ${stale.weight} at ${locKey} (dedup ${secondsLeft}s remaining)`,
        elapsedMs: Date.now() - triggerStart,
      };
    }
  }

  isCheckoutInProgress = true;
  try {
    if (payload) {
      const itemSummary =
        payload.items?.map((i) => `${i.weight} (${i.qty})`).join(", ") ?? "-";
      logger.info(
        `[Trigger] Stock signal received → location="${payload.location ?? "?"}" items=[${itemSummary}]`,
      );
    } else {
      logger.info("[Trigger] Manual checkout trigger (no payload)");
    }

    // Convert webhook payload → StockPayload for HTTP checkout
    const stockPayload: StockPayload | undefined = payload?.items?.length
      ? { location: payload.location, items: payload.items }
      : undefined;

    // ── FAST PATH: pure HTTP, no Playwright ──────────────────────────────────
    logger.info("[Trigger] Attempting HTTP-only checkout (fast path)...");
    const httpResult = await performHttpCheckout(
      config.sessionFile,
      config.targetWeights,
      config,
      stockPayload,
    );

    if (httpResult.success && httpResult.vaNumber) {
      recordPurchase(payload);
      const elapsed = Date.now() - triggerStart;
      logger.info(
        `[Trigger] ✓ HTTP fast path SUCCESS in ${elapsed}ms — VA: ${httpResult.vaNumber}`,
      );

      // Notify Telegram (fire-and-forget so we can return ASAP)
      void sendCheckoutNotification(
        httpResult.vaNumber,
        httpResult.items,
        httpResult.totalAmount,
        httpResult.orderNumber,
        config.telegramBotToken,
        config.telegramChatId,
      ).catch((err) => logger.warn("[Trigger] Telegram notify failed:", err));

      return {
        success: true,
        message: `VA: ${httpResult.vaNumber}`,
        vaNumber: httpResult.vaNumber,
        elapsedMs: elapsed,
      };
    }

    // ── ESCALATE: session expired or HTTP failed → use Playwright pipeline ──
    logger.warn(
      `[Trigger] HTTP fast path failed (${httpResult.error}) — escalating to Playwright pipeline`,
    );

    const context = await getContext(config);
    const page = await getPage(config);
    const fallbackResult = await performCheckoutFast(page, context, config, {
      // Telegram already handled inside performCheckoutFast on its own paths
    });

    const elapsed = Date.now() - triggerStart;
    if (fallbackResult.success && fallbackResult.vaNumber) {
      recordPurchase(payload);
      logger.info(
        `[Trigger] ✓ Playwright pipeline SUCCESS in ${elapsed}ms — VA: ${fallbackResult.vaNumber}`,
      );
      return {
        success: true,
        message: `VA: ${fallbackResult.vaNumber}`,
        vaNumber: fallbackResult.vaNumber,
        elapsedMs: elapsed,
      };
    }

    return {
      success: false,
      message: fallbackResult.error || httpResult.error || "Checkout failed",
      elapsedMs: elapsed,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error("[Trigger] Unhandled error:", err);
    void sendCheckoutFailureNotification(
      errMsg,
      config.telegramBotToken,
      config.telegramChatId,
    ).catch(() => {});
    return {
      success: false,
      message: errMsg,
      elapsedMs: Date.now() - triggerStart,
    };
  } finally {
    isCheckoutInProgress = false;
  }
}

async function main(): Promise<void> {
  const config = getConfig();
  logger.setLevel(config.logLevel);

  logger.info("=".repeat(50));
  logger.info("Logam Mulia - Auto Checkout Service (HTTP-first)");
  logger.info("=".repeat(50));
  logger.info("");
  logger.info(
    `Target weights : ${config.targetWeights.length > 0 ? config.targetWeights.join(", ") + "gr" : "ALL"}`,
  );
  logger.info(`Webhook port   : ${config.webhookPort}`);
  logger.info(`Cooldown       : ${config.checkoutCooldownSeconds}s after success`);
  logger.info("");

  // Session check on startup. If missing, attempt auto-login (Python script).
  // This makes the service self-healing on a fresh server (no manual `dev:login` step).
  const hasSession = await fileExists(config.sessionFile);
  if (!hasSession) {
    logger.warn(
      `[Init] Session file not found at ${config.sessionFile} — attempting auto-login...`,
    );
    const { attemptAutoLogin } = await import(
      "../../infrastructure/logammulia/session-keepalive"
    );
    const ok = await attemptAutoLogin(config);
    if (!ok) {
      logger.error(
        "[Init] Auto-login failed. Service will start anyway and rely on keepalive to recover.",
      );
      // Fire Telegram alert so the operator knows
      await sendSessionExpiredAlert(
        config.telegramBotToken,
        config.telegramChatId,
        config.authUrl || undefined,
      ).catch(() => {});
    } else {
      logger.info("[Init] ✓ Auto-login succeeded — session.json created");
    }
  } else {
    logger.info(`[Init] ✓ Session file present (${config.sessionFile})`);
  }

  // Start webhook server (lightweight, ready in milliseconds)
  startWebhookServer(config.webhookPort, handleCheckoutTrigger);

  logger.info("");
  logger.info(
    `POST http://localhost:${config.webhookPort}/checkout to trigger checkout`,
  );
  logger.info(
    "Stock-scheduler will POST here automatically when stock becomes available",
  );
  logger.info("");

  // Pre-warm Playwright in background — saves 3-5s on first webhook trigger.
  // Browser idles on /id/checkout, ready to fill form when stock signal arrives.
  void warmupBrowser(config).then(() => {
    // Refresh the warmed page every 7 minutes
    startPageRefreshLoop(config, () => isCheckoutInProgress, 7 * 60 * 1000);
  });

  // Session keepalive: ping /id/my-account every 5 minutes.
  // Sends Telegram alert if session expires.
  startKeepaliveLoop(
    config,
    () => sendSessionExpiredAlert(config.telegramBotToken, config.telegramChatId, config.authUrl || undefined),
    5 * 60 * 1000,
  );

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Received ${signal} — shutting down...`);
    await closeBrowser().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.error("[App] Fatal startup error:", err);
  process.exit(1);
});
