/**
 * Playwright-based checkout service (optimized for speed).
 * 
 * Actual flow discovered:
 *  1. /id/purchase/gold → set qty → click "Tambah ke Keranjang"
 *  2. Website auto-processes checkout → redirects to /id/my-account/order-history
 *  3. VA number is on order detail page
 * 
 * No need for /my-cart or /checkout pages!
 */

import fs from 'fs/promises';
import path from 'path';
import { Page } from 'playwright';
import { AppConfig } from '../../app/config/env';
import { logger } from '../../app/utils/logger';
import { sleep } from '../../app/utils/retry';
import { ensureDir } from '../../app/utils/file';

export interface AvailableItem {
  weight: string;
  weightNumeric: number;
  maxQty: number;
}

export interface CheckoutResult {
  success: boolean;
  vaNumber?: string;
  orderNumber?: string;
  totalAmount?: string;
  items: string[];
  error?: string;
  elapsedMs?: number;
  deadline?: string;
  shipping?: string;
}

/**
 * Ensures transaction purpose is set and stock is visible.
 * Sets location to ABDH (Pengiriman Ekspedisi) if needed.
 */
export async function ensureStockVisible(page: Page): Promise<void> {
  const hasNoStock = await page.evaluate(() =>
    document.body.innerText.includes('Tidak ada varian produk yang tersedia')
  );

  if (!hasNoStock) return;

  logger.info('[Checkout] Stock not visible - setting tujuan transaksi + location...');

  // Set transaction purpose via popup page
  await page.goto('https://www.logammulia.com/change-destination-transaction', {
    waitUntil: 'domcontentloaded', timeout: 10_000,
  });
  await sleep(500);

  const hasForm = await page.$('#tujuan_transaksi');
  if (hasForm) {
    await page.selectOption('#tujuan_transaksi', 'Investasi');
    await sleep(200);
    const btn = await page.$('#change-destination-transaction-button, input[type="submit"], button[type="submit"]');
    if (btn) await btn.click();
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
  }

  // Set location to Pengiriman Ekspedisi (ABDH)
  await page.goto('https://www.logammulia.com/id/purchase/gold', { waitUntil: 'networkidle', timeout: 15_000 });
  await sleep(500);

  const stillNoStock = await page.evaluate(() =>
    document.body.innerText.includes('Tidak ada varian produk yang tersedia')
  );

  if (stillNoStock) {
    const token = await page.evaluate(() => {
      const el = document.querySelector('meta[name="_token"]') as HTMLMetaElement;
      return el?.content || '';
    });
    await page.evaluate(async (csrfToken) => {
      const fd = new FormData();
      fd.append('_token', csrfToken);
      fd.append('location', 'ABDH');
      await fetch('https://www.logammulia.com/do-change-location', {
        method: 'POST', body: fd, credentials: 'include',
      });
    }, token);
    await page.reload({ waitUntil: 'networkidle', timeout: 15_000 });
    await sleep(1_000);
  }

  logger.info('[Checkout] Stock should now be visible');
}

/**
 * Scans the purchase page for available gramasi.
 */
export async function getAvailableItems(page: Page, targetWeights: number[]): Promise<AvailableItem[]> {
  logger.info('[Checkout] Scanning available items...');

  await ensureStockVisible(page);

  // Wait for stock table
  await page.waitForSelector('.cart-table .ct-body .ctr', { timeout: 10_000 }).catch(() => null);

  const items = await page.evaluate(() => {
    const rows = document.querySelectorAll('.cart-table .ct-body .ctr');
    return Array.from(rows).map((row) => {
      const ngcText = row.querySelector('.ngc-text');
      const qtyInput = row.querySelector('input.qty') as HTMLInputElement | null;
      const isDisabled = row.classList.contains('disabled');
      const noStock = row.querySelector('.no-stock');
      const rawWeight = ngcText
        ? Array.from(ngcText.childNodes)
            .filter((n) => n.nodeType === 3)
            .map((n) => (n as Text).textContent?.trim() ?? '')
            .filter(Boolean).join(' ').trim()
        : '';
      const maxAttr = qtyInput?.getAttribute('max') ?? '';
      const maxQty = (isDisabled || !!noStock) ? 0 : maxAttr ? parseInt(maxAttr, 10) : (qtyInput ? 1 : 0);
      return { rawWeight, maxQty, isDisabled: isDisabled || !!noStock };
    });
  });

  const available: AvailableItem[] = [];
  for (const item of items) {
    if (item.isDisabled || item.maxQty <= 0) continue;
    const match = item.rawWeight.match(/(\d+[,.]?\d*)\s*gr/i);
    if (!match) continue;
    const weightNumeric = parseFloat(match[1].replace(',', '.'));
    if (targetWeights.length > 0 && !targetWeights.some((t) => Math.abs(t - weightNumeric) < 0.001)) continue;
    available.push({ weight: item.rawWeight, weightNumeric, maxQty: item.maxQty });
  }

  logger.info(`[Checkout] Available: ${available.length} item(s): ${available.map(i => i.weightNumeric + 'gr').join(', ')}`);
  return available;
}

/**
 * Sets qty=1 for each available item, dismisses popup, and clicks "Tambah ke Keranjang".
 * After this, the website auto-processes checkout and redirects to order-history.
 */
export async function addToCartAndCheckout(page: Page, items: AvailableItem[]): Promise<string[]> {
  const addedItems: string[] = [];

  // First, clear existing cart items to avoid qty accumulation.
  // Use /remove-cart per item (the proven path from http-checkout-client) since
  // /clear-cart from purchase page context doesn't always flush my-cart items.
  await page.evaluate(async () => {
    const token = (document.querySelector('meta[name="_token"]') as HTMLMetaElement)?.content || '';
    if (!token) return;

    // 1. Best-effort /clear-cart in case it works
    await fetch('https://www.logammulia.com/clear-cart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: '_token=' + encodeURIComponent(token),
      credentials: 'include',
    }).catch(() => {});

    // 2. Fetch /id/my-cart and individually remove every item that's still there
    try {
      const cartRes = await fetch('https://www.logammulia.com/id/my-cart', {
        credentials: 'include',
      });
      const html = await cartRes.text();
      // Real structure: <a class="btn-remove-item" attr-cart="item3590141">
      const cartIds = Array.from(html.matchAll(/attr-cart="(item\d+)"/g)).map((m) => m[1]);
      for (const cartId of cartIds) {
        await fetch('https://www.logammulia.com/remove-cart', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' },
          body: 'cart=' + encodeURIComponent(cartId) + '&_token=' + encodeURIComponent(token),
          credentials: 'include',
        }).catch(() => {});
      }
    } catch {
      // ignore — best-effort cleanup
    }
  });
  await sleep(500);

  for (const item of items) {
    const success = await page.evaluate((weightNumeric) => {
      const rows = document.querySelectorAll('.cart-table .ct-body .ctr');
      for (const row of Array.from(rows)) {
        if (row.classList.contains('disabled')) continue;
        const ngcText = row.querySelector('.ngc-text');
        const rawWeight = ngcText
          ? Array.from(ngcText.childNodes).filter((n) => n.nodeType === 3).map((n) => (n as Text).textContent?.trim() ?? '').join(' ')
          : '';
        const match = rawWeight.match(/(\d+[,.]?\d*)\s*gr/i);
        if (!match) continue;
        if (Math.abs(parseFloat(match[1].replace(',', '.')) - weightNumeric) < 0.001) {
          const qtyInput = row.querySelector('input.qty') as HTMLInputElement;
          if (qtyInput) {
            qtyInput.value = '1';
            qtyInput.dispatchEvent(new Event('input', { bubbles: true }));
            qtyInput.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          }
        }
      }
      return false;
    }, item.weightNumeric);

    if (success) addedItems.push(`${item.weightNumeric}gr`);
  }

  if (addedItems.length === 0) throw new Error('Failed to set qty for any item');
  logger.info(`[Checkout] Set qty=1 for: ${addedItems.join(', ')}`);

  // Dismiss any Fancybox popup blocking the button
  await page.evaluate(() => {
    const container = document.querySelector('.fancybox-container, #fancybox-container') as HTMLElement;
    if (container) container.remove();
    const popup = document.querySelector('.popup-change-destination-transaction');
    if (popup) {
      const btn = document.querySelector('#change-destination-transaction-button') as HTMLElement;
      if (btn) btn.click();
    }
  });
  await sleep(300);

  // Click "Tambah ke Keranjang" via force click
  // First verify the button and form exist
  const preClickInfo = await page.evaluate(() => {
    const btn = document.querySelector('#add-cart-button-gold');
    const form = document.querySelector('form#purchase');
    const qtyInputs = document.querySelectorAll('input.qty');
    const filledQty = Array.from(qtyInputs).filter(i => (i as HTMLInputElement).value !== '0' && (i as HTMLInputElement).value !== '');
    return {
      hasButton: !!btn,
      hasForm: !!form,
      formAction: form?.getAttribute('action') || '',
      totalQtyInputs: qtyInputs.length,
      filledQtyInputs: filledQty.length,
      filledValues: filledQty.map(i => (i as HTMLInputElement).value),
    };
  });
  logger.info(`[Checkout] Pre-click: btn=${preClickInfo.hasButton} form=${preClickInfo.hasForm} action="${preClickInfo.formAction}" qty=${preClickInfo.filledQtyInputs}/${preClickInfo.totalQtyInputs} values=${JSON.stringify(preClickInfo.filledValues)}`);

  if (!preClickInfo.hasForm) {
    throw new Error('form#purchase not found - page may not have rendered correctly');
  }

  // Submit the form via JavaScript (most reliable)
  await page.evaluate(() => {
    const form = document.querySelector('form#purchase') as HTMLFormElement;
    if (form) form.submit();
  });

  // Wait for navigation or popup response
  try {
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10_000 });
  } catch {
    await sleep(3_000);
  }

  // Check for error popups (SweetAlert, etc.)
  const errorPopup = await page.evaluate(() => {
    const body = document.body.innerText;
    if (body.includes('Pemesanan gagal diproses') || body.includes('pembayaran terlebih dahulu')) {
      const okBtn = document.querySelector('.swal2-confirm, .swal2-actions button') as HTMLElement;
      if (okBtn) okBtn.click();
      return 'Pemesanan gagal - ada transaksi pending yang harus dibayar dulu';
    }
    if (body.includes('stok habis') || body.includes('Stok tidak tersedia')) {
      return 'Stock habis saat proses checkout';
    }
    return null;
  });

  if (errorPopup) {
    throw new Error(errorPopup);
  }

  // Verify we navigated away from purchase page
  const currentUrl = page.url();
  if (currentUrl.includes('/purchase/gold')) {
    throw new Error('Checkout tidak berhasil - masih di halaman purchase');
  }

  logger.info(`[Checkout] After add-to-cart, URL: ${currentUrl}`);
  return addedItems;
}

/**
 * Clears all items from the cart via the /clear-cart endpoint.
 * Used after a failed checkout to prevent qty accumulation on the next attempt.
 */
export async function clearCart(page: Page): Promise<void> {
  logger.info('[Checkout] Clearing cart...');
  try {
    await page.evaluate(async () => {
      const token = (document.querySelector('meta[name="_token"]') as HTMLMetaElement)?.content || '';
      if (token) {
        // First call /clear-cart to flush server-side
        await fetch('https://www.logammulia.com/clear-cart', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: '_token=' + encodeURIComponent(token),
          credentials: 'include',
        }).catch(() => {});

        // Then individually remove any remaining cart items via /remove-cart
        try {
          const cartRes = await fetch('https://www.logammulia.com/id/my-cart', {
            credentials: 'include',
          });
          const html = await cartRes.text();
          const itemMatches = Array.from(html.matchAll(/id="(item\d+)"/g)).map((m) => m[1]);
          for (const itemId of itemMatches) {
            await fetch('https://www.logammulia.com/remove-cart', {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: '_token=' + encodeURIComponent(token) + '&itemId=' + encodeURIComponent(itemId),
              credentials: 'include',
            }).catch(() => {});
          }
        } catch {
          // ignore individual cleanup failures
        }
      }
    });
    logger.info('[Checkout] Cart cleared');
  } catch (err) {
    logger.warn('[Checkout] Cart clear failed (non-critical):', err);
  }
}

/**
 * Extracts VA number from the latest order in order-history.
 * Navigates to order detail page and scrapes the VA.
 * Verifies the order was created within the last 10 minutes to avoid picking stale orders.
 */
export async function extractVAFromOrderHistory(page: Page): Promise<CheckoutResult> {
  logger.info('[Checkout] Extracting VA from order history...');

  // Navigate to order history if not already there
  if (!page.url().includes('order-history')) {
    await page.goto('https://www.logammulia.com/id/my-account/order-history', {
      waitUntil: 'domcontentloaded', timeout: 15_000,
    });
  }
  await sleep(1_000);

  // Click "View Detail" on the first (latest) order
  const clicked = await page.evaluate(() => {
    // Find all "View Detail" links
    const links = document.querySelectorAll('a');
    for (const link of Array.from(links)) {
      if (link.textContent?.trim() === 'View Detail' || link.textContent?.includes('View Detail')) {
        (link as HTMLElement).click();
        return link.getAttribute('href') || 'clicked';
      }
    }
    // Fallback: find link with order-history/ pattern
    const orderLinks = document.querySelectorAll('a[href*="order-history/"]');
    if (orderLinks.length > 0) {
      (orderLinks[0] as HTMLElement).click();
      return (orderLinks[0] as HTMLAnchorElement).href;
    }
    return null;
  });

  if (clicked) {
    logger.info(`[Checkout] Clicked order detail: ${clicked}`);
    try {
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10_000 });
    } catch {
      await sleep(2_000);
    }
  } else {
    logger.warn('[Checkout] Could not find View Detail link');
  }

  logger.info(`[Checkout] Order detail URL: ${page.url()}`);

  // Extract VA number and order details from the page
  const result = await page.evaluate(() => {
    const bodyText = document.body.innerText;

    // VA number: "Pembayaran Via Bank Mandiri: 7001400009282768"
    let vaNumber = '';
    const copyInput = document.querySelector("input[id^='copy_']") as HTMLInputElement;
    if (copyInput) {
      vaNumber = copyInput.value;
    } else {
      const vaMatch = bodyText.match(/(?:Bank\s+Mandiri|Virtual\s+Account)[:\s]*(\d{10,20})/i);
      if (vaMatch) vaNumber = vaMatch[1];
      if (!vaNumber) {
        const bankSection = bodyText.match(/Metode Pembayaran[\s\S]{0,200}/);
        if (bankSection) {
          const numMatch = bankSection[0].match(/\d{10,20}/);
          if (numMatch) vaNumber = numMatch[0];
        }
      }
    }

    // Order number
    let orderNumber = '';
    const orderMatch = bodyText.match(/#?(LMA\d+)/);
    if (orderMatch) orderNumber = orderMatch[1];

    // Total amount
    let totalAmount = '';
    const totalEl = document.querySelector('#total_price') as HTMLInputElement;
    if (totalEl) {
      totalAmount = 'Rp ' + parseInt(totalEl.value.trim()).toLocaleString('id-ID');
    } else {
      const totalMatch = bodyText.match(/Total\s+pembelian\s*:\s*(Rp[\s\d.,]+)/i);
      if (totalMatch) totalAmount = totalMatch[1].trim();
    }

    // Order date - look for "Tanggal Pesanan:" text
    let orderDate = '';
    const dateMatch = bodyText.match(/Tanggal Pesanan:\s*(\d{1,2}\s+\w+\s+\d{4}\s+\d{1,2}:\d{2}:\d{2})/i);
    if (dateMatch) orderDate = dateMatch[1];

    // Payment status
    let paymentStatus = '';
    const statusMatch = bodyText.match(/Status Terakhir\s*([\w\s]+)/i);
    if (statusMatch) paymentStatus = statusMatch[1].trim();

    return { vaNumber, orderNumber, totalAmount, orderDate, paymentStatus };
  });

  // Verify order is fresh (created within last 10 minutes)
  if (result.orderDate) {
    const orderTime = new Date(result.orderDate.replace(/(\d+)\s+(\w+)\s+(\d+)\s+(\d+:\d+:\d+)/, '$2 $1, $3 $4'));
    const ageMs = Date.now() - orderTime.getTime();
    const ageMinutes = ageMs / 60_000;
    if (ageMinutes > 10) {
      logger.warn(`[Checkout] Order ${result.orderNumber} is ${Math.round(ageMinutes)} minutes old — likely stale, not from this run`);
      return { success: false, items: [], error: `Order too old (${Math.round(ageMinutes)} min) — checkout likely failed silently` };
    }
  }

  // Check if payment is already expired
  if (result.paymentStatus && /expired/i.test(result.paymentStatus)) {
    logger.warn(`[Checkout] Order ${result.orderNumber} has expired payment — not a new order`);
    return { success: false, items: [], error: 'Order payment expired — checkout likely failed' };
  }

  if (!result.vaNumber) {
    logger.warn('[Checkout] VA number not found on order detail page');
    return { success: false, items: [], error: 'VA number not found in order detail' };
  }

  logger.info(`[Checkout] ✓ Order: ${result.orderNumber} | VA: ${result.vaNumber} | Total: ${result.totalAmount}`);
  return {
    success: true,
    vaNumber: result.vaNumber,
    orderNumber: result.orderNumber,
    totalAmount: result.totalAmount,
    items: [],
  };
}

/**
 * Saves debug screenshot and HTML.
 */
export async function saveDebugSnapshot(page: Page, config: AppConfig, prefix: string): Promise<void> {
  try {
    await ensureDir(config.debugDir);
    const ts = Date.now();
    await page.screenshot({ path: path.join(config.debugDir, `${prefix}-${ts}.png`), fullPage: true });
    const html = await page.content();
    await fs.writeFile(path.join(config.debugDir, `${prefix}-${ts}.html`), html, 'utf-8');
    logger.info(`[Debug] Snapshot saved: ${prefix}-${ts}`);
  } catch (e) {
    logger.warn('[Debug] Failed to save snapshot:', e);
  }
}

/**
 * Handles the cart page → checkout page → payment flow.
 * Called when add-to-cart redirects to /my-cart instead of order-history.
 *
 * Returns CheckoutResult with VA when extractable from success page, otherwise undefined
 * (caller should then fall back to extractVAFromOrderHistory).
 */
export async function completeCheckoutFromCart(
  page: Page,
  addedItems: string[] = [],
): Promise<CheckoutResult | undefined> {
  logger.info('[Checkout] On cart page - proceeding to checkout...');

  // Save cart page screenshot for debugging
  await saveDebugSnapshot(page, { debugDir: 'data/debug', debugScreenshotOnError: true } as any, 'cart-page');

  // Wait for page to be ready
  await sleep(1_000);

  // Try clicking the green "Checkout" button (it's likely a form submit or JS-handled link)
  let clicked = false;
  
  // First try: the green checkout button (likely has specific class or is in sidebar)
  const greenBtnClicked = await page.evaluate(() => {
    // Look for the green checkout button specifically
    const buttons = document.querySelectorAll('a, button');
    for (const btn of Array.from(buttons)) {
      const text = btn.textContent?.trim() || '';
      const classes = btn.className || '';
      // The green button likely has "checkout" text and is styled as a button
      if (text.toLowerCase() === 'checkout' && (classes.includes('btn') || classes.includes('checkout'))) {
        (btn as HTMLElement).click();
        return 'green-btn: ' + text;
      }
    }
    // Try finding by the cart icon + Checkout text pattern
    for (const btn of Array.from(buttons)) {
      const text = btn.textContent?.trim().toLowerCase() || '';
      if (text.includes('checkout') && !text.includes('kembali')) {
        (btn as HTMLElement).click();
        return 'text-btn: ' + btn.textContent?.trim();
      }
    }
    return null;
  });

  if (greenBtnClicked) {
    logger.info(`[Checkout] Clicked: ${greenBtnClicked}`);
    clicked = true;
  }

  if (!clicked) {
    // Fallback: direct navigate
    logger.info('[Checkout] Fallback: navigating directly to /checkout');
    await page.goto('https://www.logammulia.com/id/checkout', { waitUntil: 'domcontentloaded', timeout: 15_000 });
  } else {
    // Wait for navigation
    try {
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10_000 });
    } catch {
      await sleep(3_000);
    }
  }

  logger.info(`[Checkout] After cart checkout, URL: ${page.url()}`);

  // If still on cart page, force navigate to checkout
  if (page.url().includes('/my-cart')) {
    logger.warn('[Checkout] Still on cart page - force navigating to /checkout');
    await page.goto('https://www.logammulia.com/id/checkout', { waitUntil: 'domcontentloaded', timeout: 15_000 });
    await sleep(1_000);
    logger.info(`[Checkout] After force navigate, URL: ${page.url()}`);
  }

  // Now on checkout page - fill form and submit
  if (page.url().includes('/checkout')) {
    await sleep(1_000);

    // Save debug screenshot of checkout page
    await saveDebugSnapshot(page, { debugDir: 'data/debug', debugScreenshotOnError: true } as any, 'checkout-form');

    // Step 1: Select shipping address FIRST to trigger AJAX shipping cost calculation
    const addressInfo = await page.evaluate(() => {
      const addrs = Array.from(document.querySelectorAll('input[name="shippingAddress"]')) as HTMLInputElement[];
      const targetAddr = addrs.find((a) => a.getAttribute('id_province') && a.value !== '-1') ||
                         addrs.find((a) => a.checked && a.value !== '-1') ||
                         addrs.find((a) => a.value !== '-1');
      if (targetAddr) {
        targetAddr.click();
        targetAddr.dispatchEvent(new Event('change', { bubbles: true }));
        return targetAddr.value;
      }
      return null;
    });
    logger.info(`[Checkout] Selected address: ${addressInfo}`);

    // Step 2: Wait for shipping cost AJAX to complete (all couriers populated)
    await page.waitForFunction(
      () => {
        // Wait until at least one courier has cost > 0 (not just any defined)
        const radios = Array.from(document.querySelectorAll('input[name="pickCourier"]')) as HTMLInputElement[];
        return radios.some((r) => {
          const cost = (window as any)["shipping_" + r.value];
          return typeof cost === 'number' && cost > 0;
        });
      },
      { timeout: 15000 },
    ).catch(async () => {
      logger.warn("[Checkout] Shipping AJAX didn't yield any valid courier, waiting extra...");
      await sleep(5000);
    });

    // Step 3: Select courier with cost > 0 (skip "Tidak terjangkau")
    const courierResult = await page.evaluate(() => {
      const radios = Array.from(document.querySelectorAll('input[name="pickCourier"]')) as HTMLInputElement[];
      // Find courier with valid shipping cost
      let picked = '';
      for (const r of radios) {
        const cost = (window as any)["shipping_" + r.value];
        if (typeof cost === 'number' && cost > 0) {
          r.checked = true;
          r.click();
          r.dispatchEvent(new Event('change', { bubbles: true }));
          picked = r.value;
          break;
        }
      }
      // Fallback: parse from DOM (#courrier_price_top_X)
      if (!picked) {
        for (const r of radios) {
          const priceEl = document.querySelector(`#courrier_price_top_${r.value}`);
          const priceText = priceEl?.textContent || '';
          if (priceText && !priceText.includes('Tidak terjangkau') && !priceText.includes('undefined')) {
            const priceMatch = priceText.match(/[\d.,]+/);
            if (priceMatch) {
              const price = parseInt(priceMatch[0].replace(/\./g, ''), 10);
              if (price > 0) {
                (window as any)["shipping_" + r.value] = price;
                r.checked = true;
                r.click();
                r.dispatchEvent(new Event('change', { bubbles: true }));
                picked = r.value;
                break;
              }
            }
          }
        }
      }
      return picked;
    });
    logger.info(`[Checkout] Selected courier: ${courierResult}`);

    await sleep(2000); // Wait for courier change handler to finish (it resets confirmCheckout)

    // Step 4: Fix order_total manually (same fix as http-checkout-client)
    await page.evaluate(() => {
      const checkedCourier = document.querySelector('input[name="pickCourier"]:checked') as HTMLInputElement;
      if (checkedCourier) {
        const courierVal = checkedCourier.value;
        const shippingCost = (window as any)["shipping_" + courierVal] || 0;
        const priceLeft = document.querySelector('#courrier_price_left');
        if (priceLeft && shippingCost > 0) {
          priceLeft.textContent = "Rp " + shippingCost.toLocaleString('id-ID');
        }
        const orderTotalEl = document.querySelector('#order_total');
        const baseTotal = parseInt(orderTotalEl?.getAttribute('value') || '0', 10);
        if (orderTotalEl && baseTotal > 0 && shippingCost >= 0) {
          const grandTotal = baseTotal + shippingCost;
          orderTotalEl.textContent = grandTotal.toLocaleString('id-ID');
        }
      }
    });

    // Step 5: Select Bank Mandiri payment
    await page.evaluate(() => {
      const payments = document.querySelectorAll('input[name="pickPayment"]');
      for (const r of Array.from(payments)) {
        if ((r as HTMLInputElement).value === 'BMRI') {
          (r as HTMLInputElement).checked = true;
          (r as HTMLElement).click();
          break;
        }
      }
    });
    logger.info('[Checkout] Selected payment: BMRI');

    await sleep(500);

    // Step 6: Check confirmCheckout - MUST be after courier (courier handler resets it)
    // Use direct property set + dispatchEvent, NOT .click() which toggles
    await page.evaluate(() => {
      const cb = document.getElementById('confirmCheckout') as HTMLInputElement;
      if (cb) {
        cb.checked = true;
        cb.dispatchEvent(new Event('change', { bubbles: true }));
      }
      // Also check greeting_card if present
      const gc = document.querySelector('input[name="greeting_card"]') as HTMLInputElement;
      if (gc && !gc.checked) {
        gc.checked = true;
        gc.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    await sleep(300);
    // Double-check: force it again right before submit
    await page.evaluate(() => {
      const cb = document.getElementById('confirmCheckout') as HTMLInputElement;
      if (cb) cb.checked = true;
    });
    const confirmState = await page.evaluate(() => {
      return (document.getElementById('confirmCheckout') as HTMLInputElement)?.checked;
    });
    logger.info(`[Checkout] confirmCheckout: ${confirmState}`);

    await sleep(500);

    // Step 7: Submit via #btnContinueOrder with check_kurir bypass
    logger.info('[Checkout] Submitting payment...');
    await page.evaluate(() => {
      (window as any).check_kurir = 1;
      const btn = document.querySelector('#btnContinueOrder') as HTMLButtonElement;
      if (btn) btn.click();
    });

    // Step 8: Handle SweetAlert (confirmation vs validation error)
    const swalResult = await page.waitForSelector(
      ".swal-overlay .swal-button, .swal2-confirm, .swal-button--confirm",
      { timeout: 10000 },
    ).catch(() => null);

    if (swalResult) {
      const swalInfo = await page.evaluate(() => {
        const titleEl = document.querySelector(".swal-title, .swal2-title");
        const textEl = document.querySelector(".swal-text, .swal2-html-container");
        return {
          title: titleEl?.textContent?.trim() || "",
          text: textEl?.textContent?.trim() || "",
        };
      });
      logger.info(`[Checkout] SweetAlert: "${swalInfo.title}" - "${swalInfo.text}"`);

      const isError = /silahkan pilih|tidak terjangkau|persetujuan gagal|beri tanda centang|gagal/i.test(
        swalInfo.title + " " + swalInfo.text,
      );

      await swalResult.click().catch(() => {});

      if (isError) {
        throw new Error(`Checkout validation failed: ${swalInfo.title} - ${swalInfo.text}`);
      }
    }

    // Step 9: Wait for success page
    await page.waitForFunction(
      () => {
        const url = window.location.href;
        const isSuccessUrl = !url.includes('/id/checkout') && url.includes('/checkout');
        const hasSuccessText = document.body?.textContent?.includes("Pesanan Selesai") ||
          !!document.querySelector("input[id^='copy_']");
        return isSuccessUrl || hasSuccessText;
      },
      { timeout: 30000 },
    ).catch(() => {});

    await sleep(2000);
    logger.info(`[Checkout] After payment, URL: ${page.url()}`);

    // Save screenshot after submit attempt
    await saveDebugSnapshot(page, { debugDir: 'data/debug', debugScreenshotOnError: true } as any, 'after-submit');

    // Step 10: Try to extract VA directly from success page first
    const directVA = await page.evaluate(() => {
      const copyInput = document.querySelector("input[id^='copy_']") as HTMLInputElement;
      if (copyInput) return copyInput.value;
      const bodyText = document.body.innerText;
      const vaMatch = bodyText.match(/(?:Bank\s+Mandiri|Virtual\s+Account)[:\s]*(\d{10,20})/i);
      return vaMatch ? vaMatch[1] : null;
    });

    if (directVA) {
      const orderDetails = await page.evaluate(() => {
        const bodyText = document.body.innerText;

        // Order number
        const orderMatch = bodyText.match(/#?(LMA\d+)/);
        const orderNum = orderMatch ? orderMatch[1] : '';

        // Grand total: page has "Jumlah: IDR 27.461.001" (includes shipping)
        // Hidden #total_price is subtotal-only and may be wrong
        let totalAmt = '';
        const jumlahMatch = bodyText.match(/Jumlah:\s*IDR\s*([\d.,]+)/i);
        if (jumlahMatch) {
          totalAmt = 'Rp ' + jumlahMatch[1];
        } else {
          const m = bodyText.match(/Harga Total\s*Rp\s*([\d.,]+)/i);
          if (m) totalAmt = 'Rp ' + m[1];
        }

        // Items from inline JS: var checkout_complete_array = [{...}]
        const productItems: string[] = [];
        const html = document.documentElement.innerHTML;
        const arrayMatch = html.match(/checkout_complete_array\s*=\s*(\[[^\]]+\])/);
        if (arrayMatch) {
          try {
            const parsed = JSON.parse(arrayMatch[1]) as Array<{ item_name?: string; quantity?: number }>;
            for (const it of parsed) {
              if (it.item_name) {
                const qty = it.quantity ?? 1;
                productItems.push(`${it.item_name} x${qty}`);
              }
            }
          } catch {
            // ignore parse errors
          }
        }

        // Payment deadline
        const deadlineMatch = bodyText.match(/Pembayaran Maksimal Sebelum\s*:\s*([^\n]+)/i);
        const deadline = deadlineMatch ? deadlineMatch[1].trim() : '';

        // Shipping cost row: "Kurir   Rp 76.001"
        const shippingMatch = bodyText.match(/Kurir[^\n]*?Rp\s*([\d.,]+)/i);
        const shipping = shippingMatch ? `Rp ${shippingMatch[1]}` : '';

        return { orderNum, totalAmt, productItems, deadline, shipping };
      });

      logger.info(`[Checkout] ✓ Direct VA extraction: ${orderDetails.orderNum} | VA: ${directVA} | Total: ${orderDetails.totalAmt} | Items: ${orderDetails.productItems.join(', ')}`);
      return {
        success: true,
        vaNumber: directVA,
        orderNumber: orderDetails.orderNum,
        totalAmount: orderDetails.totalAmt,
        items: orderDetails.productItems.length > 0 ? orderDetails.productItems : addedItems,
        deadline: orderDetails.deadline,
        shipping: orderDetails.shipping,
      };
    }
  }
}
