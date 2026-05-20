import { Page, BrowserContext } from 'playwright';
import { AppConfig } from '../../app/config/env';
import { logger } from '../../app/utils/logger';
import { ensureLoggedIn } from '../../infrastructure/logammulia/auth-service';
import {
  getAvailableItems,
  addToCartAndCheckout,
  completeCheckoutFromCart,
  extractVAFromOrderHistory,
  saveDebugSnapshot,
  CheckoutResult,
} from '../../infrastructure/logammulia/checkout-service';
import {
  sendCheckoutNotification,
  sendCheckoutFailureNotification,
} from '../../infrastructure/telegram/telegram-client';

/**
 * Full checkout flow:
 * 1. Ensure logged in → purchase page
 * 2. Scan available items
 * 3. Set qty=1, submit "Tambah ke Keranjang"
 * 4a. If redirects to order-history → extract VA directly
 * 4b. If redirects to /my-cart → cart → checkout → pay → extract VA
 * 5. Send Telegram notification
 */
export async function performCheckout(
  page: Page,
  context: BrowserContext,
  config: AppConfig,
  options?: { skipTelegram?: boolean },
): Promise<CheckoutResult> {
  const startTime = Date.now();

  try {
    // Step 1: Ensure logged in
    await ensureLoggedIn(page, context, config);

    // Step 2: Get available items
    const available = await getAvailableItems(page, config.targetWeights);
    if (available.length === 0) {
      return { success: false, items: [], error: 'No stock available' };
    }

    // Step 3: Add to cart
    const addedItems = await addToCartAndCheckout(page, available);

    // Step 4: Handle redirect destination
    const currentUrl = page.url();
    if (currentUrl.includes('/my-cart') || currentUrl.includes('/cart')) {
      // Flow B: cart → checkout → pay
      const directResult = await completeCheckoutFromCart(page, addedItems);
      if (directResult?.success && directResult.vaNumber) {
        const elapsed = Date.now() - startTime;
        logger.info(`[Checkout] ✓ Completed in ${elapsed}ms - VA: ${directResult.vaNumber}`);
        if (!options?.skipTelegram) {
          await sendCheckoutNotification(
            directResult.vaNumber,
            directResult.items,
            directResult.totalAmount,
            directResult.orderNumber,
            config.telegramBotToken,
            config.telegramChatId,
          );
        }
        return { ...directResult, elapsedMs: elapsed };
      }
    }
    // If already on order-history, skip (Flow A: direct checkout)

    // Step 5: Extract VA from order history (fallback)
    const result = await extractVAFromOrderHistory(page);
    result.items = addedItems;

    const elapsed = Date.now() - startTime;

    // Step 6: Telegram notification
    if (result.success && result.vaNumber) {
      logger.info(`[Checkout] ✓ Completed in ${elapsed}ms - VA: ${result.vaNumber}`);
      if (!options?.skipTelegram) {
        await sendCheckoutNotification(
          result.vaNumber, result.items, result.totalAmount,
          result.orderNumber, config.telegramBotToken, config.telegramChatId,
        );
      }
    } else {
      logger.warn(`[Checkout] ⚠ VA tidak ditemukan (${elapsed}ms)`);
      if (!options?.skipTelegram) {
        await sendCheckoutFailureNotification(
          result.error || 'VA number not found', config.telegramBotToken, config.telegramChatId,
        ).catch(() => {});
      }
    }

    return result;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const elapsed = Date.now() - startTime;
    logger.error(`[Checkout] Failed after ${elapsed}ms: ${errorMsg}`);

    if (config.debugScreenshotOnError) {
      await saveDebugSnapshot(page, config, 'checkout-error');
    }

    if (!options?.skipTelegram) {
      await sendCheckoutFailureNotification(
        errorMsg, config.telegramBotToken, config.telegramChatId,
      ).catch(() => {});
    }

    return { success: false, items: [], error: errorMsg };
  }
}
