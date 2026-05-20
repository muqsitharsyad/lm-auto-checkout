import { Browser, BrowserContext, Page } from 'playwright';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { AppConfig } from '../../app/config/env';
import { logger } from '../../app/utils/logger';
import { loadSession } from './session-store';

// Apply stealth plugin to avoid bot detection
chromium.use(StealthPlugin());

const CHECKOUT_URL = 'https://www.logammulia.com/id/checkout';

let _browser: Browser | null = null;
let _context: BrowserContext | null = null;
let _page: Page | null = null;
let _refreshInterval: NodeJS.Timeout | null = null;

export async function getBrowser(config: AppConfig): Promise<Browser> {
  if (_browser && _browser.isConnected()) {
    return _browser;
  }

  logger.info('[Browser] Launching Chromium (stealth mode)...');
  _browser = await chromium.launch({
    headless: config.headless,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  _browser.on('disconnected', () => {
    logger.warn('[Browser] Browser disconnected unexpectedly');
    _browser = null;
    _context = null;
    _page = null;
  });

  return _browser;
}

export async function getContext(config: AppConfig): Promise<BrowserContext> {
  if (_context) {
    return _context;
  }

  const browser = await getBrowser(config);
  const session = await loadSession(config.sessionFile);

  _context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    locale: 'id-ID',
    ...(session ? { storageState: session } : {}),
  });

  return _context;
}

export async function getPage(config: AppConfig): Promise<Page> {
  if (_page && !_page.isClosed()) {
    return _page;
  }

  const context = await getContext(config);
  _page = await context.newPage();

  return _page;
}

/**
 * Pre-warm: launch browser, load session, navigate to checkout page.
 * After this completes, getPage() returns a page already on /id/checkout.
 * Saves 3-5 seconds when a webhook fires.
 */
export async function warmupBrowser(config: AppConfig): Promise<void> {
  try {
    logger.info('[Warmup] Pre-warming browser to checkout page...');
    const start = Date.now();
    const page = await getPage(config);
    await page.goto(CHECKOUT_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    logger.info(`[Warmup] ✓ Browser ready on checkout page (${Date.now() - start}ms)`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`[Warmup] Pre-warm failed (will lazy-init on demand): ${msg}`);
  }
}

/**
 * Periodic page refresh to keep the warmed page session alive and current.
 * Runs every `intervalMs` (default 3 minutes). Skips if a checkout is in progress.
 * Returns a stop function.
 */
export function startPageRefreshLoop(
  config: AppConfig,
  isCheckoutInProgress: () => boolean,
  intervalMs = 3 * 60 * 1000,
): () => void {
  if (_refreshInterval) {
    clearInterval(_refreshInterval);
  }

  _refreshInterval = setInterval(async () => {
    if (isCheckoutInProgress()) {
      logger.debug('[Warmup] Skipping refresh — checkout in progress');
      return;
    }
    if (!_page || _page.isClosed()) {
      logger.debug('[Warmup] Page closed, attempting re-warmup');
      await warmupBrowser(config);
      return;
    }
    try {
      const currentUrl = _page.url();
      // Only refresh if still on checkout-related page
      if (currentUrl.includes('/checkout') || currentUrl.includes('logammulia.com')) {
        await _page.goto(CHECKOUT_URL, { waitUntil: 'domcontentloaded', timeout: 15_000 });
        logger.debug('[Warmup] Page refreshed');
      }
    } catch (err) {
      logger.warn('[Warmup] Page refresh failed (non-critical):', err);
    }
  }, intervalMs);

  return () => {
    if (_refreshInterval) {
      clearInterval(_refreshInterval);
      _refreshInterval = null;
    }
  };
}

export async function closeBrowser(): Promise<void> {
  if (_refreshInterval) {
    clearInterval(_refreshInterval);
    _refreshInterval = null;
  }
  if (_page) {
    await _page.close().catch(() => undefined);
    _page = null;
  }
  if (_context) {
    await _context.close().catch(() => undefined);
    _context = null;
  }
  if (_browser) {
    await _browser.close().catch(() => undefined);
    _browser = null;
  }
  logger.info('[Browser] Browser closed');
}

export async function recreateContext(config: AppConfig): Promise<BrowserContext> {
  if (_page) {
    await _page.close().catch(() => undefined);
    _page = null;
  }
  if (_context) {
    await _context.close().catch(() => undefined);
    _context = null;
  }
  return getContext(config);
}
