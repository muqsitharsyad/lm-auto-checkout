/**
 * CLI: Manual login via browser (solve captcha), save session.
 * 
 * Usage: npm run dev:login
 */

import { getConfig } from '../../app/config/env';
import { logger } from '../../app/utils/logger';
import { getBrowser, getContext, getPage, closeBrowser } from '../../infrastructure/browser/playwright-client';
import { login, isLoggedIn } from '../../infrastructure/logammulia/auth-service';
import { saveSession } from '../../infrastructure/browser/session-store';

const PURCHASE_URL = 'https://www.logammulia.com/id/purchase/gold';

async function main(): Promise<void> {
  const config = getConfig();
  logger.setLevel(config.logLevel);

  logger.info('='.repeat(50));
  logger.info('Logam Mulia - Manual Login');
  logger.info('='.repeat(50));
  logger.info('');
  logger.info('Browser will open. Solve the CAPTCHA if needed.');
  logger.info('');

  try {
    await getBrowser(config);
    const context = await getContext(config);
    const page = await getPage(config);

    await page.goto(PURCHASE_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    if (await isLoggedIn(page)) {
      logger.info('✓ Already logged in!');
    } else {
      logger.info('Not logged in. Starting login...');
      await login(page, config, false);
    }

    // Save session
    await saveSession(context, config.sessionFile);

    logger.info('');
    logger.info('✓ Login successful!');
    logger.info(`  Session: ${config.sessionFile}`);
    logger.info('');
    logger.info('You can now run: npm run dev (service) or npm run dev:checkout (test)');
  } catch (err) {
    logger.error('Login failed:', err);
    process.exit(1);
  } finally {
    await closeBrowser();
  }
}

main();
