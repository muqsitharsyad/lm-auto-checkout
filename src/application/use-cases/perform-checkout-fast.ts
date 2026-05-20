/**
 * HTTP-first checkout use case.
 *
 * Strategy for < 10 second checkout:
 *  1. Try HTTP checkout first (fastest: ~3-7 seconds)
 *  2. If HTTP fails due to session issues, fall back to Playwright
 *
 * The session is maintained by Playwright (login + reCAPTCHA),
 * but the actual checkout is done via HTTP for speed.
 */

import { Page, BrowserContext } from "playwright";
import { AppConfig } from "../../app/config/env";
import { logger } from "../../app/utils/logger";
import {
  performHttpCheckout,
  StockPayload,
} from "../../infrastructure/logammulia/http-checkout-client";
import { ensureLoggedIn } from "../../infrastructure/logammulia/auth-service";
import { saveSession } from "../../infrastructure/browser/session-store";
import {
  getAvailableItems,
  addToCartAndCheckout,
  completeCheckoutFromCart,
  extractVAFromOrderHistory,
  saveDebugSnapshot,
  clearCart,
  CheckoutResult,
} from "../../infrastructure/logammulia/checkout-service";
import {
  sendCheckoutNotification,
  sendCheckoutFailureNotification,
} from "../../infrastructure/telegram/telegram-client";

/**
 * HTTP-first checkout with Playwright fallback.
 *
 * Timeline target:
 *  - HTTP path: ~3-7 seconds (no browser rendering)
 *  - Playwright fallback: ~20-35 seconds (only if HTTP fails)
 */
export async function performCheckoutFast(
  page: Page,
  context: BrowserContext,
  config: AppConfig,
  options?: { skipTelegram?: boolean; stockPayload?: StockPayload },
): Promise<CheckoutResult> {
  const startTime = Date.now();

  // ═══════════════════════════════════════════════════════════════════════════
  // FAST PATH: HTTP-only checkout (~3-7 seconds)
  // ═══════════════════════════════════════════════════════════════════════════
  logger.info("[Fast-Checkout] Attempting HTTP-first checkout...");

  const httpResult = await performHttpCheckout(
    config.sessionFile,
    config.targetWeights,
    config,
    options?.stockPayload,
  );

  if (httpResult.success && httpResult.vaNumber) {
    const elapsed = Date.now() - startTime;
    logger.info(
      `[Fast-Checkout] ✓ HTTP checkout SUCCESS in ${elapsed}ms - VA: ${httpResult.vaNumber}`,
    );

    // Send Telegram notification
    if (!options?.skipTelegram) {
      await sendCheckoutNotification(
        httpResult.vaNumber,
        httpResult.items,
        httpResult.totalAmount,
        httpResult.orderNumber,
        config.telegramBotToken,
        config.telegramChatId,
      );
    }

    return {
      success: true,
      vaNumber: httpResult.vaNumber,
      orderNumber: httpResult.orderNumber,
      totalAmount: httpResult.totalAmount,
      items: httpResult.items,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Check if failure is due to session expiry → re-login + retry HTTP
  // ═══════════════════════════════════════════════════════════════════════════
  if (
    httpResult.error?.includes("session expired") ||
    httpResult.error?.includes("Not logged in")
  ) {
    logger.warn(
      "[Fast-Checkout] Session expired — re-login via Playwright then retry HTTP...",
    );

    try {
      await ensureLoggedIn(page, context, config);
      await saveSession(context, config.sessionFile);
      logger.info(
        "[Fast-Checkout] Re-login successful, retrying HTTP checkout...",
      );

      const retryResult = await performHttpCheckout(
        config.sessionFile,
        config.targetWeights,
        config,
      );

      if (retryResult.success && retryResult.vaNumber) {
        const elapsed = Date.now() - startTime;
        logger.info(
          `[Fast-Checkout] ✓ HTTP retry SUCCESS in ${elapsed}ms - VA: ${retryResult.vaNumber}`,
        );

        if (!options?.skipTelegram) {
          await sendCheckoutNotification(
            retryResult.vaNumber,
            retryResult.items,
            retryResult.totalAmount,
            retryResult.orderNumber,
            config.telegramBotToken,
            config.telegramChatId,
          );
        }

        return {
          success: true,
          vaNumber: retryResult.vaNumber,
          orderNumber: retryResult.orderNumber,
          totalAmount: retryResult.totalAmount,
          items: retryResult.items,
        };
      }
    } catch (loginErr) {
      logger.error("[Fast-Checkout] Re-login failed:", loginErr);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FALLBACK: Playwright checkout (slower but more reliable)
  // ═══════════════════════════════════════════════════════════════════════════
  logger.warn(
    `[Fast-Checkout] HTTP failed (${httpResult.error}), falling back to Playwright...`,
  );

  try {
    await ensureLoggedIn(page, context, config);

    // Clear cart explicitly before Playwright path — HTTP path may have left items
    logger.info("[Fast-Checkout] Clearing cart before Playwright checkout...");
    await clearCart(page).catch(() => {});

    const available = await getAvailableItems(page, config.targetWeights);
    if (available.length === 0) {
      const noStockResult: CheckoutResult = {
        success: false,
        items: [],
        error: "No stock available",
      };

      if (!options?.skipTelegram) {
        await sendCheckoutFailureNotification(
          "No stock available",
          config.telegramBotToken,
          config.telegramChatId,
        ).catch(() => {});
      }

      return noStockResult;
    }

    const addedItems = await addToCartAndCheckout(page, available);

    const currentUrl = page.url();
    if (currentUrl.includes("/my-cart") || currentUrl.includes("/cart")) {
      const directResult = await completeCheckoutFromCart(page, addedItems);
      if (directResult?.success && directResult.vaNumber) {
        const elapsed = Date.now() - startTime;
        logger.info(
          `[Fast-Checkout] ✓ Playwright fallback SUCCESS in ${elapsed}ms - VA: ${directResult.vaNumber}`,
        );
        if (!options?.skipTelegram) {
          await sendCheckoutNotification(
            directResult.vaNumber,
            directResult.items,
            directResult.totalAmount,
            directResult.orderNumber,
            config.telegramBotToken,
            config.telegramChatId,
            { deadline: directResult.deadline, shipping: directResult.shipping },
          );
        }
        return { ...directResult, elapsedMs: elapsed };
      }
    }

    const result = await extractVAFromOrderHistory(page);
    result.items = addedItems;

    const elapsed = Date.now() - startTime;

    if (result.success && result.vaNumber) {
      logger.info(
        `[Fast-Checkout] ✓ Playwright fallback SUCCESS in ${elapsed}ms - VA: ${result.vaNumber}`,
      );
      if (!options?.skipTelegram) {
        await sendCheckoutNotification(
          result.vaNumber,
          result.items,
          result.totalAmount,
          result.orderNumber,
          config.telegramBotToken,
          config.telegramChatId,
        );
      }
    } else {
      logger.warn(
        `[Fast-Checkout] ⚠ Playwright fallback failed (${elapsed}ms)`,
      );
      // Clean up cart on failure
      await clearCart(page).catch(() => {});
      if (!options?.skipTelegram) {
        await sendCheckoutFailureNotification(
          result.error || "VA number not found",
          config.telegramBotToken,
          config.telegramChatId,
        ).catch(() => {});
      }
    }

    return result;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const elapsed = Date.now() - startTime;
    logger.error(
      `[Fast-Checkout] All methods failed after ${elapsed}ms: ${errorMsg}`,
    );

    if (config.debugScreenshotOnError) {
      await saveDebugSnapshot(page, config, "fast-checkout-error");
    }

    // Clean up cart so the next attempt starts fresh (prevents qty accumulation)
    await clearCart(page).catch(() => {});

    if (!options?.skipTelegram) {
      await sendCheckoutFailureNotification(
        errorMsg,
        config.telegramBotToken,
        config.telegramChatId,
      ).catch(() => {});
    }

    return { success: false, items: [], error: errorMsg };
  }
}
