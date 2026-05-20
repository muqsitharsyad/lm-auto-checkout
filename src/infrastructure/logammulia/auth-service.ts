import fs from 'fs/promises';
import path from 'path';
import { Page, BrowserContext } from 'playwright';
import { AppConfig } from '../../app/config/env';
import { logger } from '../../app/utils/logger';
import { withRetry } from '../../app/utils/retry';
import { ensureDir } from '../../app/utils/file';
import { saveSession, deleteSession } from '../browser/session-store';
import { SELECTORS, URLS } from './selectors';
import { solveRecaptchaIfPresent } from './captcha-solver';

/**
 * Checks if the current page reflects a logged-in user.
 */
export async function isLoggedIn(page: Page): Promise<boolean> {
  const url = page.url();

  if (url.includes('/login')) {
    return false;
  }

  try {
    const loginForm = await page.$(SELECTORS.login.loginForm);
    if (loginForm) return false;
  } catch { /* ignore */ }

  // Check for logout link (definitive indicator of logged-in state)
  try {
    const logoutLink = await page.$('a[href*="/logout"]');
    if (logoutLink) return true;
  } catch { /* ignore */ }

  // Check if user-desktop shows a name (not "MASUK / DAFTAR")
  try {
    const userText = await page.$eval('li.user-desktop', (el) => el.textContent?.trim() || '');
    if (userText && !userText.includes('MASUK') && !userText.includes('DAFTAR')) {
      return true;
    }
  } catch { /* ignore */ }

  return false;
}

/**
 * Performs login with credentials from config.
 */
/**
 * Performs login.
 *
 * - When `forceAutoSolve = true` (default): always run auto captcha solve flow
 *   (Python STT → Wit.ai → fail). Used for unattended scheduled / fallback logins.
 * - When `forceAutoSolve = false` AND `config.headless = false`: enter manual mode
 *   — leaves the browser open so a human can solve the captcha. Only used by
 *   the explicit `dev:login` CLI on a developer machine.
 */
export async function login(
  page: Page,
  config: AppConfig,
  forceAutoSolve = true,
): Promise<void> {
  logger.info('[Auth] Navigating to login page...');
  await withRetry(
    () => page.goto(URLS.login, { waitUntil: 'networkidle', timeout: 30_000 }),
    { maxAttempts: 3, delayMs: 2_000 },
    'navigate to login page',
  );

  logger.info('[Auth] Filling login credentials...');
  try {
    await page.waitForSelector(SELECTORS.login.emailInput, { timeout: 15_000 });
    await page.fill(SELECTORS.login.emailInput, config.lmEmail);
    await page.fill(SELECTORS.login.passwordInput, config.lmPassword);

    // Manual mode (only when explicitly requested via dev:login + HEADLESS=false)
    if (!forceAutoSolve && !config.headless) {
      logger.info('[Auth] Manual mode: please solve CAPTCHA and click LOGIN button in the browser.');
      logger.info('[Auth] Waiting up to 3 minutes for login to complete...');
      try {
        await page.waitForURL((url) => !url.toString().includes('/login'), {
          timeout: 180_000,
          waitUntil: 'networkidle',
        });
        logger.info('[Auth] Login successful ✓');
        return;
      } catch (err) {
        if (page.url().includes('/login')) {
          throw new Error('[Auth] Timed out waiting for manual login (3 min)');
        }
        throw err;
      }
    }

    // Auto-solve mode: Python STT → Wit.ai → fail
    logger.info('[Auth] Auto-solve mode: attempting captcha bypass...');
    await solveRecaptchaIfPresent(page, config.witAiToken, true);
    await page.click(SELECTORS.login.submitButton);
    await page.waitForLoadState('networkidle', { timeout: 60_000 });

    if (page.url().includes('/login')) {
      throw new Error('[Auth] Login failed — still on login page');
    }

    logger.info('[Auth] Login successful ✓');
  } catch (err) {
    logger.error('[Auth] Login failed:', err);
    if (config.debugScreenshotOnError) {
      await saveDebugSnapshot(page, config, 'login-error');
    }
    throw err;
  }
}

/**
 * Ensures the session is authenticated.
 * If not logged in, performs login and saves session.
 */
export async function ensureLoggedIn(
  page: Page,
  context: BrowserContext,
  config: AppConfig,
): Promise<void> {
  logger.info('[Auth] Checking session validity...');

  await withRetry(
    () => page.goto(URLS.purchase, { waitUntil: 'networkidle', timeout: 30_000 }),
    { maxAttempts: 3, delayMs: 2_000 },
    'navigate to purchase page',
  );

  if (await isLoggedIn(page)) {
    logger.info('[Auth] Session is valid ✓');
    return;
  }

  logger.warn('[Auth] Session invalid — performing login...');
  await deleteSession(config.sessionFile);
  await login(page, config);
  await saveSession(context, config.sessionFile);
  await page.goto(URLS.purchase, { waitUntil: 'networkidle', timeout: 30_000 });
  logger.info('[Auth] Re-authentication complete');
}

async function saveDebugSnapshot(page: Page, config: AppConfig, prefix: string): Promise<void> {
  try {
    await ensureDir(config.debugDir);
    const ts = Date.now();
    const screenshotPath = path.join(config.debugDir, `${prefix}-${ts}.png`);
    const htmlPath = path.join(config.debugDir, `${prefix}-${ts}.html`);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    const html = await page.content();
    await fs.writeFile(htmlPath, html, 'utf-8');
    logger.info(`[Debug] Screenshot → ${screenshotPath}`);
  } catch (e) {
    logger.warn('[Debug] Failed to save debug snapshot:', e);
  }
}
