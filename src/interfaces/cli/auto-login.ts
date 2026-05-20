/**
 * CLI: Test auto-login with Python STT (no manual intervention).
 * Used to verify auto-login flow works before deploying to server.
 */

import { getConfig } from '../../app/config/env';
import { logger } from '../../app/utils/logger';
import { closeBrowser } from '../../infrastructure/browser/playwright-client';
import { attemptAutoLogin } from '../../infrastructure/logammulia/session-keepalive';

async function main(): Promise<void> {
  const config = getConfig();
  logger.setLevel(config.logLevel);

  logger.info('='.repeat(50));
  logger.info('Logam Mulia - Auto Login Test');
  logger.info('='.repeat(50));
  logger.info('');

  const success = await attemptAutoLogin(config);

  if (success) {
    logger.info('✓ Auto-login successful!');
  } else {
    logger.error('✗ Auto-login failed (captcha likely could not be solved)');
  }

  await closeBrowser();
  process.exit(success ? 0 : 1);
}

main();
