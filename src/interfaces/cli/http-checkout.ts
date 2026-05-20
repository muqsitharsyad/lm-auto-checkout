/**
 * Standalone HTTP checkout tester.
 *
 * Usage: npm run dev:http-checkout
 *
 * This bypasses Playwright entirely and tests pure HTTP checkout speed.
 * Requires a valid session.json file (run "npm run dev:login" first).
 */

import { getConfig } from "../../app/config/env";
import { logger } from "../../app/utils/logger";
import { performHttpCheckout } from "../../infrastructure/logammulia/http-checkout-client";
import {
  sendCheckoutNotification,
  sendCheckoutFailureNotification,
} from "../../infrastructure/telegram/telegram-client";

async function main(): Promise<void> {
  const config = getConfig();
  logger.setLevel(config.logLevel);

  logger.info("═".repeat(60));
  logger.info("HTTP Checkout Speed Test");
  logger.info("═".repeat(60));
  logger.info("");
  logger.info(
    `Target weights: ${config.targetWeights.length > 0 ? config.targetWeights.join(", ") + "gr" : "ALL"}`,
  );
  logger.info(`Session file: ${config.sessionFile}`);
  logger.info("");

  const startTime = Date.now();
  logger.info(
    `[${new Date().toLocaleTimeString("id-ID")}] Starting HTTP checkout...`,
  );

  const result = await performHttpCheckout(
    config.sessionFile,
    config.targetWeights,
    config,
  );

  const elapsed = Date.now() - startTime;

  logger.info("");
  logger.info("─".repeat(60));
  logger.info(`Time: ${elapsed}ms (${(elapsed / 1000).toFixed(2)}s)`);
  logger.info("─".repeat(60));

  if (result.success && result.vaNumber) {
    logger.info(`✓ SUCCESS`);
    logger.info(`  VA Number: ${result.vaNumber}`);
    logger.info(`  Order: ${result.orderNumber || "-"}`);
    logger.info(`  Total: ${result.totalAmount || "-"}`);
    logger.info(`  Items: ${result.items.join(", ")}`);

    // Send Telegram notification
    await sendCheckoutNotification(
      result.vaNumber,
      result.items,
      result.totalAmount,
      result.orderNumber,
      config.telegramBotToken,
      config.telegramChatId,
    );
  } else {
    logger.error(`✗ FAILED`);
    logger.error(`  Error: ${result.error}`);
    logger.error(`  Items attempted: ${result.items.join(", ")}`);

    // Send failure notification
    await sendCheckoutFailureNotification(
      result.error || "Unknown error",
      config.telegramBotToken,
      config.telegramChatId,
    ).catch(() => {});
  }

  logger.info("");
  logger.info(
    `Target: < 10,000ms | Actual: ${elapsed}ms | ${elapsed < 10000 ? "✓ PASS" : "✗ SLOW"}`,
  );
  logger.info("");

  process.exit(result.success ? 0 : 1);
}

main().catch((err) => {
  logger.error("Fatal error:", err);
  process.exit(1);
});
