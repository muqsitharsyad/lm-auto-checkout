/**
 * CLI: Manual checkout test (Playwright-based).
 * 
 * Usage: npm run dev:checkout
 */

import { getConfig } from '../../app/config/env';
import { logger } from '../../app/utils/logger';
import { getBrowser, getContext, getPage, closeBrowser } from '../../infrastructure/browser/playwright-client';
import { performCheckout } from '../../application/use-cases/perform-checkout';

async function main(): Promise<void> {
  const config = getConfig();
  logger.setLevel(config.logLevel);

  logger.info('='.repeat(50));
  logger.info('Logam Mulia - Checkout Test (Playwright)');
  logger.info('='.repeat(50));
  logger.info('');
  logger.info(`Target weights: ${config.targetWeights.length > 0 ? config.targetWeights.join(', ') + 'gr' : 'ALL'}`);
  logger.info('Telegram: DISABLED (test mode)');
  logger.info('');

  try {
    await getBrowser(config);
    const context = await getContext(config);
    const page = await getPage(config);

    const startTime = Date.now();
    const result = await performCheckout(page, context, config, { skipTelegram: true });
    const elapsed = Date.now() - startTime;

    logger.info('');
    logger.info('='.repeat(50));
    if (result.success) {
      logger.info(`✓ CHECKOUT SUCCESSFUL (${elapsed}ms)`);
      logger.info(`  VA Number: ${result.vaNumber}`);
      logger.info(`  Items: ${result.items.join(', ')}`);
      if (result.totalAmount) logger.info(`  Total: ${result.totalAmount}`);
      if (result.orderNumber) logger.info(`  Order: ${result.orderNumber}`);
    } else {
      logger.error(`✗ CHECKOUT FAILED (${elapsed}ms)`);
      logger.error(`  Error: ${result.error}`);
    }
    logger.info('='.repeat(50));
  } catch (err) {
    logger.error('Fatal error:', err);
    process.exit(1);
  } finally {
    await closeBrowser();
  }
}

main();
