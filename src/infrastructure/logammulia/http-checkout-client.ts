/**
 * HTTP-based checkout client — eliminates Playwright overhead for speed.
 *
 * Strategy:
 *  1. Reuse session cookies from Playwright login (valid for 1+ hours)
 *  2. All checkout operations via HTTP (no browser rendering)
 *  3. Target: < 10 seconds from trigger to VA number
 *
 * Flow (discovered from actual HTML dumps):
 *  1. GET /id/purchase/gold → get CSRF token + stock data
 *  2. POST form#purchase with qty inputs → redirects to /my-cart
 *  3. GET /checkout → get checkout form CSRF + address ID
 *  4. POST /checkout with courier + payment + address → redirects to order detail
 *  5. Extract VA from response HTML
 *
 * Optimization: if webhook payload provides stock items, skip step 1's stock parsing
 * and go directly to form submission.
 */

import axios, { AxiosInstance } from "axios";
import { wrapper } from "axios-cookiejar-support";
import { CookieJar, Cookie } from "tough-cookie";
import * as cheerio from "cheerio";
import fs from "fs/promises";
import path from "path";
import { AppConfig } from "../../app/config/env";
import { logger } from "../../app/utils/logger";
import { getPage } from "../browser/playwright-client";

// Track last-set location to skip redundant switch
let lastSetLocation: string | null = null;

/** Reset location tracking (call after session refresh) */
export function resetLocationState(): void {
  lastSetLocation = null;
}

export interface HttpCheckoutResult {
  success: boolean;
  vaNumber?: string;
  orderNumber?: string;
  totalAmount?: string;
  items: string[];
  error?: string;
  elapsedMs: number;
}

export interface AvailableItem {
  weight: string;
  weightNumeric: number;
  maxQty: number;
}

/** Payload received from stock-scheduler webhook */
export interface StockPayload {
  location?: string;
  locationCode?: string;
  items: { weight: string; qty: number }[];
}

const BASE_URL = "https://www.logammulia.com";
const PURCHASE_URL = `${BASE_URL}/id/purchase/gold`;
const ADD_TO_CART_URL = `${BASE_URL}/add-to-cart-multiple`;
const CHECKOUT_URL = `${BASE_URL}/id/checkout`;
const CHECKOUT_SUBMIT_URL = `${BASE_URL}/checkout`;
const CLEAR_CART_URL = `${BASE_URL}/clear-cart`;
const CHANGE_LOCATION_URL = `${BASE_URL}/do-change-location`;

const REQUEST_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
  "Cache-Control": "max-age=0",
  "sec-ch-ua":
    '"Google Chrome";v="124", "Chromium";v="124", "Not-A.Brand";v="99"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "sec-fetch-dest": "document",
  "sec-fetch-mode": "navigate",
  "sec-fetch-site": "same-origin",
  "sec-fetch-user": "?1",
  "upgrade-insecure-requests": "1",
};

/**
 * Creates an axios instance with cookie support from Playwright session.
 */
async function createClientFromSession(
  sessionFile: string,
): Promise<{ client: AxiosInstance; jar: CookieJar }> {
  const jar = new CookieJar();

  // Load Playwright session file and extract cookies
  try {
    const sessionData = JSON.parse(await fs.readFile(sessionFile, "utf-8"));
    if (sessionData.cookies && Array.isArray(sessionData.cookies)) {
      let loaded = 0;
      for (const cookie of sessionData.cookies) {
        // Skip cookies for non-logammulia domains (Google, Tiktok, etc.)
        const domain = cookie.domain || "www.logammulia.com";
        if (!domain.includes("logammulia.com")) continue;

        // Strip leading dot from domain (e.g. .logammulia.com → logammulia.com)
        // tough-cookie handles dot-prefix internally
        const cleanDomain = domain.replace(/^\./, "");
        // URL must use a real host, not a dot-prefixed domain
        const setCookieUrl = `https://${cleanDomain}${cookie.path || "/"}`;

        try {
          const toughCookie = new Cookie({
            key: cookie.name,
            value: cookie.value,
            domain: cleanDomain,
            path: cookie.path || "/",
            secure: cookie.secure || false,
            httpOnly: cookie.httpOnly || false,
          });
          await jar.setCookie(toughCookie, setCookieUrl);
          loaded++;
        } catch (cookieErr) {
          logger.debug(
            `[HTTP-Checkout] Failed to load cookie ${cookie.name}: ${cookieErr instanceof Error ? cookieErr.message : cookieErr}`,
          );
        }
      }
      logger.info(
        `[HTTP-Checkout] Loaded ${loaded}/${sessionData.cookies.length} cookies from session`,
      );
    }
  } catch (err) {
    logger.warn("[HTTP-Checkout] Failed to load session cookies:", err);
  }

  const client = wrapper(
    axios.create({
      jar,
      withCredentials: true,
      timeout: 30_000,
      maxRedirects: 5, // Follow redirects automatically
      headers: REQUEST_HEADERS,
    }),
  );

  return { client, jar };
}

/**
 * Extracts CSRF token from HTML.
 */
function extractCsrfToken(html: string): string | null {
  const $ = cheerio.load(html);
  return $('meta[name="_token"]').attr("content") ?? null;
}

/**
 * Parses available stock items from purchase page HTML.
 */
function parseAvailableItems(
  html: string,
  targetWeights: number[],
): AvailableItem[] {
  const $ = cheerio.load(html);
  const items: AvailableItem[] = [];

  $(".cart-table .ct-body .ctr").each((_, row) => {
    const $row = $(row);
    const isDisabled = $row.hasClass("disabled");
    const hasNoStock = $row.find("span.no-stock").length > 0;

    // Extract weight from .ngc-text
    const ngcText = $row.find(".ngc-text").first();
    const rawWeight = ngcText
      .contents()
      .filter((_, n) => n.type === "text")
      .first()
      .text()
      .trim();

    if (!rawWeight) return;

    // Extract max qty from input
    const qtyInput = $row.find("input.qty");
    const maxQty =
      isDisabled || hasNoStock ? 0 : parseInt(qtyInput.attr("max") || "1", 10);

    // Parse weight numeric
    const match = rawWeight.match(/(\d+[,.]?\d*)\s*gr/i);
    if (!match) return;

    const weightNumeric = parseFloat(match[1].replace(",", "."));

    // Filter by target weights
    if (
      targetWeights.length > 0 &&
      !targetWeights.some((t) => Math.abs(t - weightNumeric) < 0.001)
    )
      return;

    if (maxQty > 0) {
      items.push({ weight: rawWeight, weightNumeric, maxQty });
    }
  });

  return items;
}

/**
 * Extracts product rows from purchase page HTML.
 * Each row has: id_variant (hidden), qty input (name="qty[]"), weight attribute.
 * Returns map of weight -> id_variant for available items.
 */
function extractProductVariants(
  html: string,
): Array<{ weight: number; rawWeight: string; idVariant: string; available: boolean }> {
  const $ = cheerio.load(html);
  const variants: Array<{ weight: number; rawWeight: string; idVariant: string; available: boolean }> = [];

  $(".cart-table .ct-body .ctr").each((_, row) => {
    const $row = $(row);
    const isDisabled = $row.hasClass("disabled");
    const hasNoStock = $row.find("span.no-stock").length > 0;

    const ngcText = $row.find(".ngc-text").first();
    const rawWeight = ngcText
      .contents()
      .filter((_, n) => n.type === "text")
      .first()
      .text()
      .trim();

    const match = rawWeight.match(/(\d+[,.]?\d*)\s*gr/i);
    if (!match) return;
    const weight = parseFloat(match[1].replace(",", "."));

    const idVariant = $row.find('input[name="id_variant[]"]').attr("value") || "";
    const available = !isDisabled && !hasNoStock;

    if (idVariant) {
      variants.push({ weight, rawWeight, idVariant, available });
    }
  });

  return variants;
}

/**
 * Performs checkout using HTTP only (no browser).
 *
 * @param sessionFile - Path to Playwright session.json with cookies
 * @param targetWeights - Gramasi to buy (empty = all available)
 * @param config - App config
 * @param stockPayload - Optional stock info from webhook (skips stock page parsing)
 */
export async function performHttpCheckout(
  sessionFile: string,
  targetWeights: number[],
  config: AppConfig,
  stockPayload?: StockPayload,
): Promise<HttpCheckoutResult> {
  const startTime = Date.now();

  try {
    // Step 1: Create HTTP client with session cookies
    const { client } = await createClientFromSession(sessionFile);

    // Step 2: GET purchase page → CSRF + verify login + get form inputs
    // Even if we have stockPayload, we still need CSRF and form input names
    logger.info("[HTTP-Checkout] Step 1: Fetching purchase page (CSRF + form)...");
    const purchaseResp = await client.get(PURCHASE_URL);
    const purchaseHtml = purchaseResp.data as string;
    let csrfToken = extractCsrfToken(purchaseHtml);

    if (!csrfToken) {
      throw new Error("CSRF token not found - session may be invalid");
    }

    // Check if we're logged in
    const $purchase = cheerio.load(purchaseHtml);
    const hasLogout = $purchase('a[href*="/logout"]').length > 0;
    if (!hasLogout) {
      throw new Error(
        "Not logged in - session expired, need Playwright re-login",
      );
    }

    // Switch location if locationCode provided (required to see stock for specific butik)
    if (stockPayload?.locationCode && csrfToken) {
      if (lastSetLocation === stockPayload.locationCode) {
        logger.info(`[HTTP-Checkout] Location already ${stockPayload.locationCode}, skipping switch`);
      } else {
        logger.info(
          `[HTTP-Checkout] Switching location to "${stockPayload.location ?? stockPayload.locationCode}"...`,
        );
        await client.post(
          CHANGE_LOCATION_URL,
          new URLSearchParams({
            _token: csrfToken,
            location: stockPayload.locationCode,
          }).toString(),
          { headers: { "Content-Type": "application/x-www-form-urlencoded" } },
        );
        lastSetLocation = stockPayload.locationCode;
      }

      // Re-fetch purchase page after location switch
      logger.info("[HTTP-Checkout] Re-fetching purchase page after location switch...");
      const refreshResp = await client.get(PURCHASE_URL);
      const refreshHtml = refreshResp.data as string;
      csrfToken = extractCsrfToken(refreshHtml) || csrfToken;

      // Re-parse available items from refreshed page
      let available: AvailableItem[];
      if (stockPayload.items.length > 0) {
        available = stockPayload.items
          .filter((i) => i.qty > 0)
          .map((i) => {
            const match = i.weight.match(/(\d+[,.]?\d*)/);
            const weightNumeric = match ? parseFloat(match[1].replace(",", ".")) : 0;
            return { weight: i.weight, weightNumeric, maxQty: i.qty };
          });
        logger.info(
          `[HTTP-Checkout] Using webhook payload: ${available.length} item(s)`,
        );
      } else {
        available = parseAvailableItems(refreshHtml, targetWeights);
        logger.info(
          `[HTTP-Checkout] Parsed from HTML: ${available.length} available item(s)`,
        );
      }

      if (available.length === 0) {
        return {
          success: false,
          items: [],
          error: "No stock available after location switch",
          elapsedMs: Date.now() - startTime,
        };
      }

      // Build form data from refreshed page using id_variant[] + qty[] arrays
      const variants = extractProductVariants(refreshHtml);
      const purchaseFormData = new URLSearchParams();
      purchaseFormData.append("_token", csrfToken);

      const addedItems: string[] = [];
      for (const variant of variants) {
        const isTarget =
          targetWeights.length === 0 ||
          targetWeights.some((t) => Math.abs(t - variant.weight) < 0.001);
        const isAvailable = variant.available &&
          available.some((a) => Math.abs(a.weightNumeric - variant.weight) < 0.001);

        if (isTarget && isAvailable) {
          purchaseFormData.append("id_variant[]", variant.idVariant);
          purchaseFormData.append("qty[]", "1");
          addedItems.push(`${variant.weight}gr`);
          logger.info(
            `[HTTP-Checkout] Set qty=1 for ${variant.weight}gr (id_variant: ${variant.idVariant})`,
          );
        } else {
          purchaseFormData.append("id_variant[]", variant.idVariant);
          purchaseFormData.append("qty[]", "0");
        }
      }

      if (addedItems.length === 0) {
        return {
          success: false,
          items: [],
          error: "No matching items found in form after location switch",
          elapsedMs: Date.now() - startTime,
        };
      }

      // Continue with cart + checkout (skip the normal flow below)
      logger.info("[HTTP-Checkout] Step 2: Clearing cart + adding items...");
      // Clear cart first (sequential - must complete before adding)
      try {
        await client.get(`${BASE_URL}/id/my-cart`);
        // Remove all items by posting to remove-cart for each
        const cartResp = await client.get<string>(`${BASE_URL}/id/my-cart`);
        const $cart = cheerio.load(cartResp.data);
        const cartItems = $cart('.btn-remove-item');
        for (let i = 0; i < cartItems.length; i++) {
          const cartId = $cart(cartItems[i]).attr('attr-cart') || '';
          if (cartId) {
            logger.debug(`[HTTP-Checkout] Removing cart item: ${cartId}`);
            await client.post(
              `${BASE_URL}/remove-cart`,
              new URLSearchParams({ _token: csrfToken, cart: cartId }).toString(),
              { headers: { "Content-Type": "application/x-www-form-urlencoded" } },
            ).catch(() => {});
          }
        }
      } catch {
        // Ignore clear errors
      }

      // Add to cart
      logger.info("[HTTP-Checkout] Adding items to cart...");
      await client.post(
        ADD_TO_CART_URL,
        purchaseFormData.toString(),
        { headers: { "Content-Type": "application/x-www-form-urlencoded" } },
      );

      await Promise.resolve();

      // Checkout page
      logger.info("[HTTP-Checkout] Step 3: Fetching checkout page...");
      const checkoutResp = await client.get(CHECKOUT_URL);
      const checkoutHtml = checkoutResp.data as string;
      return completeCheckout(client, checkoutHtml, csrfToken, addedItems, startTime, config);
    }

    // Parse available items (either from payload or HTML)
    let available: AvailableItem[];
    if (stockPayload && stockPayload.items.length > 0) {
      // Use payload data - convert to AvailableItem format
      available = stockPayload.items
        .filter((i) => i.qty > 0)
        .map((i) => {
          const match = i.weight.match(/(\d+[,.]?\d*)/);
          const weightNumeric = match ? parseFloat(match[1].replace(",", ".")) : 0;
          return { weight: i.weight, weightNumeric, maxQty: i.qty };
        });
      logger.info(
        `[HTTP-Checkout] Using webhook payload: ${available.length} item(s) from "${stockPayload.location ?? "unknown"}"`,
      );
    } else {
      // Fallback: parse from HTML
      available = parseAvailableItems(purchaseHtml, targetWeights);
      logger.info(
        `[HTTP-Checkout] Parsed from HTML: ${available.length} available item(s)`,
      );
    }

    if (available.length === 0) {
      return {
        success: false,
        items: [],
        error: "No stock available",
        elapsedMs: Date.now() - startTime,
      };
    }

    // Step 3: Build form data using id_variant[] + qty[] arrays
    const variants = extractProductVariants(purchaseHtml);
    const purchaseFormData = new URLSearchParams();
    purchaseFormData.append("_token", csrfToken);

    // Add qty for target items
    const addedItems: string[] = [];
    for (const variant of variants) {
      const isTarget =
        targetWeights.length === 0 ||
        targetWeights.some((t) => Math.abs(t - variant.weight) < 0.001);
      const isAvailable = variant.available &&
        available.some((a) => Math.abs(a.weightNumeric - variant.weight) < 0.001);

      purchaseFormData.append("id_variant[]", variant.idVariant);
      if (isTarget && isAvailable) {
        purchaseFormData.append("qty[]", "1");
        addedItems.push(`${variant.weight}gr`);
        logger.info(
          `[HTTP-Checkout] Set qty=1 for ${variant.weight}gr (id_variant: ${variant.idVariant})`,
        );
      } else {
        purchaseFormData.append("qty[]", "0");
      }
    }

    if (addedItems.length === 0) {
      return {
        success: false,
        items: [],
        error: "No matching items found in form",
        elapsedMs: Date.now() - startTime,
      };
    }

    // Step 4: Clear cart + submit purchase form in parallel
    logger.info("[HTTP-Checkout] Step 2: Clearing cart + adding items...");
    const clearCartPromise = client
      .post(CLEAR_CART_URL, `_token=${csrfToken}`, {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      })
      .catch(() => {}); // Ignore errors

    const addCartPromise = client.post(
      ADD_TO_CART_URL,
      purchaseFormData.toString(),
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      },
    );

    await Promise.all([clearCartPromise, addCartPromise]);

    // Step 5: GET checkout page + parse in parallel
    logger.info("[HTTP-Checkout] Step 3: Fetching checkout page...");
    const checkoutResp = await client.get(CHECKOUT_URL);
    const checkoutHtml = checkoutResp.data as string;
    const $checkout = cheerio.load(checkoutHtml);

    // Extract fresh CSRF token
    csrfToken = extractCsrfToken(checkoutHtml) || csrfToken;

    // Extract shipping address ID (first valid one, skip value="-1")
    let addressId = "";
    $checkout('input[name="shippingAddress"]').each((_, el) => {
      const val = String($checkout(el).attr("value") || "");
      if (val && val !== "-1" && !addressId) {
        addressId = val;
      }
    });

    if (!addressId) {
      throw new Error("No valid shipping address found on checkout page");
    }

    logger.info(`[HTTP-Checkout] Using address ID: ${addressId}`);

    // Step 6: Build and submit checkout form
    // Courier: 1=RPX (cheapest), 3=Paxel, 5=JNE
    // Payment: BMRI=Mandiri, BRIN=BRI, CENA=BCA, BBBA=Permata
    const checkoutFormData = new URLSearchParams();
    checkoutFormData.append("_token", csrfToken);
    checkoutFormData.append("tax_type", "PPH22");
    checkoutFormData.append("pickCourier", "1"); // RPX (cheapest)
    checkoutFormData.append("pickPayment", "BMRI"); // Mandiri VA
    checkoutFormData.append("shippingAddress", addressId);
    checkoutFormData.append("valDiscount", "0");

    // Check all agreement checkboxes
    $checkout('input[type="checkbox"]').each((_, el) => {
      const name = $checkout(el).attr("name");
      if (name) {
        checkoutFormData.append(name, "1");
      }
    });

    logger.info("[HTTP-Checkout] Step 4: Submitting checkout form...");
    const checkoutResult = await client.post(
      CHECKOUT_SUBMIT_URL,
      checkoutFormData.toString(),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "Referer": CHECKOUT_URL,
          "Origin": BASE_URL,
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Sec-Fetch-Dest": "document",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Site": "same-origin",
          "Sec-Fetch-User": "?1",
        },
        maxRedirects: 10,
        validateStatus: () => true,
      },
    );

    const finalHtml = checkoutResult.data as string;
    const finalUrl =
      checkoutResult.request?.res?.responseUrl || CHECKOUT_SUBMIT_URL;

    logger.info(`[HTTP-Checkout] Final URL: ${finalUrl}`);

    // Step 7: Extract VA number from response
    let vaNumber = "";
    let orderNumber = "";
    let totalAmount = "";

    // VA patterns from actual HTML
    const vaMatch = finalHtml.match(
      /(?:Bank\s+Mandiri|Virtual\s+Account|Pembayaran\s+Via\s+Bank\s+Mandiri)[:\s]*(\d{10,20})/i,
    );
    if (vaMatch) vaNumber = vaMatch[1];

    // Order number (LMA + digits)
    const orderMatch = finalHtml.match(/(LMA\d+)/);
    if (orderMatch) orderNumber = orderMatch[1];

    // Total amount
    const totalMatch = finalHtml.match(
      /Total\s+pembelian\s*:\s*(Rp[\s\d.,]+)/i,
    );
    if (totalMatch) totalAmount = totalMatch[1].trim();

    const elapsedMs = Date.now() - startTime;

    if (vaNumber) {
      logger.info(
        `[HTTP-Checkout] ✓ SUCCESS in ${elapsedMs}ms - VA: ${vaNumber}`,
      );
      return {
        success: true,
        vaNumber,
        orderNumber,
        totalAmount,
        items: addedItems,
        elapsedMs,
      };
    } else {
      // Save debug HTML
      if (config.debugScreenshotOnError) {
        const debugPath = path.join(
          config.debugDir,
          `http-checkout-${Date.now()}.html`,
        );
        await fs.mkdir(config.debugDir, { recursive: true });
        await fs.writeFile(debugPath, finalHtml, "utf-8");
        logger.info(`[HTTP-Checkout] Debug HTML saved: ${debugPath}`);
      }

      return {
        success: false,
        items: addedItems,
        error: "VA number not found in response",
        elapsedMs,
      };
    }
  } catch (err) {
    const elapsedMs = Date.now() - startTime;
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error(`[HTTP-Checkout] Failed after ${elapsedMs}ms: ${errorMsg}`);

    return {
      success: false,
      items: [],
      error: errorMsg,
      elapsedMs,
    };
  }
}

/**
 * Quick stock check via HTTP.
 */
export async function checkStockHttp(
  sessionFile: string,
  targetWeights: number[],
): Promise<{ hasStock: boolean; items: AvailableItem[] }> {
  try {
    const { client } = await createClientFromSession(sessionFile);
    const resp = await client.get(PURCHASE_URL);
    const html = resp.data as string;
    const items = parseAvailableItems(html, targetWeights);

    return { hasStock: items.length > 0, items };
  } catch (err) {
    logger.error("[HTTP-Checkout] Stock check failed:", err);
    return { hasStock: false, items: [] };
  }
}

/**
 * Complete checkout using Playwright (fallback when HTTP submit fails).
 * Opens checkout page, selects shipping/payment, submits form, extracts VA.
 */
async function completeCheckoutWithPlaywright(
  config: AppConfig,
  addedItems: string[],
  startTime: number,
): Promise<HttpCheckoutResult> {
  logger.info("[Playwright-Checkout] Starting Playwright checkout fallback...");

  const page = await getPage(config);

  try {
    // Step 1: Navigate to checkout page
    logger.info("[Playwright-Checkout] Navigating to checkout page...");
    await page.goto(CHECKOUT_URL, { waitUntil: "domcontentloaded", timeout: 30000 });

    // Wait for checkout form to appear
    await page.waitForSelector("#checkout-form", { timeout: 10000 }).catch(() => {});

    // Step 2: Click address radio to trigger AJAX shipping cost calculation
    logger.info("[Playwright-Checkout] Selecting shipping address to trigger shipping cost AJAX...");
    const addressInfo = await page.evaluate(() => {
      const addrs = Array.from(document.querySelectorAll('input[name="shippingAddress"]')) as HTMLInputElement[];
      const targetAddr = addrs.find((a) => a.getAttribute('id_province') && a.value !== '-1') ||
                         addrs.find((a) => a.checked && a.value !== '-1') ||
                         addrs.find((a) => a.value !== '-1');
      if (targetAddr) {
        targetAddr.click();
        targetAddr.dispatchEvent(new Event('change', { bubbles: true }));
        return { value: targetAddr.value, idProvince: targetAddr.getAttribute('id_province') };
      }
      return null;
    });
    if (addressInfo) {
      logger.info(`[Playwright-Checkout] Selected address ${addressInfo.value} (id_province: ${addressInfo.idProvince})`);
    }

    // Step 3: Wait for shipping costs AJAX to complete
    logger.info("[Playwright-Checkout] Waiting for shipping costs AJAX...");
    await page.waitForFunction(
      () => {
        // Check if any shipping_X variable is set (AJAX completed)
        return (window as any)["shipping_1"] !== undefined ||
               (window as any)["shipping_3"] !== undefined ||
               (window as any)["shipping_5"] !== undefined;
      },
      { timeout: 15000 },
    ).catch(async () => {
      logger.warn("[Playwright-Checkout] Shipping cost AJAX didn't set variables, waiting extra...");
      await page.waitForTimeout(5000);
    });

    // Get available couriers with cost via DOM
    const courierInfo = await page.evaluate(() => {
      const radios = Array.from(document.querySelectorAll('input[name="pickCourier"]')) as HTMLInputElement[];
      return radios.map((r) => {
        const priceEl = document.querySelector(`#courrier_price_top_${r.value}`);
        const priceText = priceEl?.textContent || '';
        return {
          value: r.value,
          priceText: priceText.trim(),
          available: priceText && !priceText.includes('Tidak terjangkau') && !priceText.includes('Pengiriman tidak tersedia') && !priceText.includes('undefined'),
        };
      });
    });
    logger.info(`[Playwright-Checkout] Couriers found: ${JSON.stringify(courierInfo)}`);

    let selectedCourier = "";
    const validCourier = courierInfo.find((c) => c.available);
    if (validCourier) {
      selectedCourier = validCourier.value;
    } else if (courierInfo.length > 0) {
      // Fall back to first courier even if no price showing
      selectedCourier = courierInfo[0].value;
      logger.warn("[Playwright-Checkout] No valid courier with price found, using first courier");
    }

    if (selectedCourier) {
      // Click the courier radio and set shipping cost variables manually
      await page.evaluate((v: string) => {
        const r = document.querySelector(`input[name="pickCourier"][value="${v}"]`) as HTMLInputElement;
        if (r) {
          // Set the window.shipping_X variable from the displayed price text
          const priceEl = document.querySelector(`#courrier_price_top_${v}`);
          const priceText = priceEl?.textContent || '';
          const priceMatch = priceText.match(/[\d.,]+/);
          if (priceMatch) {
            // Parse "76.001" format (Indonesian number format)
            const price = parseInt(priceMatch[0].replace(/\./g, ''), 10);
            (window as any)["shipping_" + v] = price;
            console.log(`Set window.shipping_${v} = ${price}`);
          }

          r.checked = true;
          r.click();
          r.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }, selectedCourier);
      logger.info(`[Playwright-Checkout] Selected courier ${selectedCourier}`);
    }

    // Wait for total update after courier selection, then fix it manually if needed
    await page.waitForTimeout(1000);

    // Manually fix order_total and courrier_price_left if they're still broken
    await page.evaluate(() => {
      const checkedCourier = document.querySelector('input[name="pickCourier"]:checked') as HTMLInputElement;
      if (checkedCourier) {
        const courierVal = checkedCourier.value;
        const shippingCost = (window as any)["shipping_" + courierVal] || 0;

        // Update courrier_price_left
        const priceLeft = document.querySelector('#courrier_price_left');
        if (priceLeft && shippingCost > 0) {
          priceLeft.textContent = "Rp " + shippingCost.toLocaleString('id-ID');
        }

        // Update order_total
        const orderTotalEl = document.querySelector('#order_total');
        const baseTotal = parseInt(orderTotalEl?.getAttribute('value') || '0', 10);
        if (orderTotalEl && baseTotal > 0 && shippingCost >= 0) {
          const grandTotal = baseTotal + shippingCost;
          orderTotalEl.textContent = grandTotal.toLocaleString('id-ID');
          console.log(`Fixed order_total: ${baseTotal} + ${shippingCost} = ${grandTotal}`);
        }
      }
    });

    logger.info("[Playwright-Checkout] Fixed order total calculation");

    // Step 5: Select Bank Mandiri payment - use evaluate to handle styled radio
    await page.evaluate(() => {
      const r = document.querySelector('input[name="pickPayment"][value="BMRI"]') as HTMLInputElement;
      if (r) {
        r.checked = true;
        r.dispatchEvent(new Event('change', { bubbles: true }));
        r.click();
      }
    });
    logger.info("[Playwright-Checkout] Selected Bank Mandiri payment");

    await page.waitForTimeout(500);

    // Step 6: Check confirmCheckout checkbox
    // IMPORTANT: courier change handler sets confirmCheckout.checked = false,
    // so this MUST happen after courier selection. Don't .click() after setting .checked=true,
    // because click() toggles checkboxes (would set it back to false).
    await page.evaluate(() => {
      const cb = document.querySelector('input[name="confirmCheckout"]') as HTMLInputElement;
      if (cb) {
        if (!cb.checked) {
          cb.click(); // click() will set checked=true and fire change
        }
        // Defensive: ensure it's checked
        cb.checked = true;
        cb.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    const isChecked = await page.evaluate(() => {
      const cb = document.querySelector('input[name="confirmCheckout"]') as HTMLInputElement;
      return cb?.checked || false;
    });
    logger.info(`[Playwright-Checkout] confirmCheckout state: ${isChecked}`);

    await page.waitForTimeout(500);

    // Step 7: Set check_kurir to bypass validation, then submit form
    logger.info("[Playwright-Checkout] Clicking submit button...");
    await page.evaluate(() => {
      // Bypass the check_kurir == 0 validation that blocks submit
      (window as any).check_kurir = 1;

      const btn = document.querySelector('#btnContinueOrder') as HTMLButtonElement;
      if (btn) {
        btn.click();
      }
    });

    // Step 8: Wait for SweetAlert confirmation dialog (timer 3000ms = visible briefly)
    logger.info("[Playwright-Checkout] Waiting for confirmation dialog or navigation...");

    // Race: wait for either swal dialog or URL change
    const result = await Promise.race([
      page.waitForSelector(
        ".swal-overlay .swal-button, .swal2-confirm, .swal-button--confirm",
        { timeout: 15000 },
      ).then((el) => ({ type: "swal" as const, el })).catch(() => null),
      page.waitForFunction(
        () => {
          // Check for redirect or order success
          const url = window.location.href;
          return !url.includes('/checkout') || document.querySelector('.order-success, [class*="success"]');
        },
        { timeout: 15000 },
      ).then(() => ({ type: "navigation" as const })).catch(() => null),
    ]);

    if (result?.type === "swal") {
      // Read the SweetAlert content to determine if it's a confirmation or validation error
      const swalInfo = await page.evaluate(() => {
        const titleEl = document.querySelector(".swal-title, .swal2-title");
        const textEl = document.querySelector(".swal-text, .swal2-html-container, .swal2-content");
        return {
          title: titleEl?.textContent?.trim() || "",
          text: textEl?.textContent?.trim() || "",
        };
      });
      logger.info(`[Playwright-Checkout] SweetAlert - title: "${swalInfo.title}", text: "${swalInfo.text}"`);

      // Detect validation error vs confirmation
      const isValidationError =
        /silahkan pilih kurir|alamat pengiriman|tidak terjangkau|tidak dapat ditemukan|wajib|harus|persetujuan gagal|beri tanda centang/i.test(
          swalInfo.title + " " + swalInfo.text,
        );

      if (isValidationError) {
        logger.warn(`[Playwright-Checkout] Validation error detected: ${swalInfo.title}`);
      } else {
        logger.info("[Playwright-Checkout] Confirmation dialog, clicking confirm...");
      }

      try {
        await result.el?.click();
      } catch {
        await page.click(".swal-overlay .swal-button, .swal2-confirm, .swal-button--confirm").catch(() => {});
      }

      if (isValidationError) {
        // Validation failed - submit won't navigate. Save debug and exit.
        await page.waitForTimeout(1000);
        const errContent = await page.content();
        const errPath = path.join(config.debugDir, `playwright-validation-error-${Date.now()}.html`);
        await fs.mkdir(config.debugDir, { recursive: true });
        await fs.writeFile(errPath, errContent, "utf-8");
        logger.info(`[Playwright-Checkout] Validation error HTML saved: ${errPath}`);

        return {
          success: false,
          items: addedItems,
          error: `Playwright validation failed: ${swalInfo.title}`,
          elapsedMs: Date.now() - startTime,
        };
      }
    } else if (result?.type === "navigation") {
      logger.info("[Playwright-Checkout] Page navigated, checking final URL...");
    } else {
      logger.warn("[Playwright-Checkout] Neither dialog nor navigation detected");
    }

    // Step 9: Wait for navigation to order success page
    // The success page is at https://www.logammulia.com/checkout (no /id/ prefix)
    // and contains "Pesanan Selesai!" or LMA order number.
    logger.info("[Playwright-Checkout] Waiting for order confirmation page...");
    await page
      .waitForFunction(
        () => {
          const url = window.location.href;
          const isSuccessUrl =
            url.includes("/order") ||
            url.includes("/purchase/order") ||
            url.includes("/my-account") ||
            (!url.includes("/id/checkout") && url.includes("/checkout"));
          // Also check page content for completion indicator
          const hasSuccessText =
            document.body?.textContent?.includes("Pesanan Selesai") ||
            document.body?.textContent?.includes("Akun Virtual Bank") ||
            !!document.querySelector("input[id^='copy_']");
          return isSuccessUrl || hasSuccessText;
        },
        { timeout: 30000 },
      )
      .catch(() => {
        logger.warn("[Playwright-Checkout] Order success indicator not found");
      });

    // Wait for page content to load
    await page.waitForTimeout(2500);

    // Step 10: Extract VA number from success page
    const pageContent = await page.content();
    const pageUrl = page.url();
    logger.info(`[Playwright-Checkout] Final URL: ${pageUrl}`);

    let vaNumber = "";
    let orderNumber = "";
    let totalAmount = "";

    // VA patterns from success page
    // Page structure: "Akun Virtual Bank Mandiri :\n<input ... id="copy_7001400009290339" value="7001400009290339" readonly>"
    const vaMatch =
      pageContent.match(/id="copy_(\d{10,20})"\s+value="\d{10,20}"/i) ||
      pageContent.match(/Akun Virtual Bank Mandiri[\s\S]{0,500}?value="(\d{10,20})"/i) ||
      pageContent.match(/Akun Virtual Bank Mandiri\s*[:\s]*(\d{10,20})/i) ||
      pageContent.match(/(?:Bank\s+Mandiri|Virtual\s+Account|Pembayaran\s+Via\s+Bank\s+Mandiri)[:\s]*(\d{10,20})/i);
    if (vaMatch) vaNumber = vaMatch[1];

    // Order number - actual format is #LMA1836938 (LMA + 7 digits)
    const orderMatch = pageContent.match(/#?(LMA\d+)/);
    if (orderMatch) orderNumber = orderMatch[1];

    // Total amount - input id="total_price" value=" 27385000.00 "
    const totalMatch =
      pageContent.match(/id="total_price"\s+value="\s*(\d+(?:\.\d+)?)\s*"/i) ||
      pageContent.match(/Total\s+pembelian\s*:\s*(Rp[\s\d.,]+)/i);
    if (totalMatch) totalAmount = totalMatch[1].trim();

    const elapsedMs = Date.now() - startTime;

    if (vaNumber) {
      logger.info(`[Playwright-Checkout] SUCCESS in ${elapsedMs}ms - VA: ${vaNumber}`);
      return {
        success: true,
        vaNumber,
        orderNumber,
        totalAmount,
        items: addedItems,
        elapsedMs,
      };
    }

    // Save debug HTML if VA not found
    if (config.debugScreenshotOnError) {
      const debugPath = path.join(config.debugDir, `playwright-checkout-${Date.now()}.html`);
      await fs.mkdir(config.debugDir, { recursive: true });
      await fs.writeFile(debugPath, pageContent, "utf-8");
      logger.info(`[Playwright-Checkout] Debug HTML saved: ${debugPath}`);

      // Also save screenshot
      const screenshotPath = path.join(config.debugDir, `playwright-checkout-${Date.now()}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });
      logger.info(`[Playwright-Checkout] Screenshot saved: ${screenshotPath}`);
    }

    return {
      success: false,
      items: addedItems,
      error: "VA number not found after Playwright checkout",
      elapsedMs,
    };
  } catch (err) {
    const elapsedMs = Date.now() - startTime;
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error(`[Playwright-Checkout] Failed after ${elapsedMs}ms: ${errorMsg}`);

    // Save debug screenshot on error
    if (config.debugScreenshotOnError) {
      try {
        const screenshotPath = path.join(config.debugDir, `playwright-error-${Date.now()}.png`);
        await fs.mkdir(config.debugDir, { recursive: true });
        await page.screenshot({ path: screenshotPath, fullPage: true });
        logger.info(`[Playwright-Checkout] Error screenshot saved: ${screenshotPath}`);
      } catch {}
    }

    return {
      success: false,
      items: addedItems,
      error: errorMsg,
      elapsedMs,
    };
  }
}

/**
 * Complete checkout: fetch checkout page, submit form, extract VA number.
 * Shared between location-switched flow and direct flow.
 */
async function completeCheckout(
  client: AxiosInstance,
  checkoutHtml: string,
  csrfToken: string,
  addedItems: string[],
  startTime: number,
  config: AppConfig,
): Promise<HttpCheckoutResult> {
  const $checkout = cheerio.load(checkoutHtml);
  csrfToken = extractCsrfToken(checkoutHtml) || csrfToken;

  // Find best shipping address based on available couriers:
  //  - Pickup butik (courier 2 only): use butik address (no id_province)
  //  - Ekspedisi (courier 1/3/5): use personal address (with id_province)
  let butikAddressId = "";
  let personalAddressId = "";
  let checkedAddressId = "";
  $checkout('input[name="shippingAddress"]').each((_, el) => {
    const $el = $checkout(el);
    const val = String($el.attr("value") || "");
    const isChecked = $el.attr("checked") !== undefined;
    const hasProvince = $el.attr("id_province");

    if (val && val !== "-1") {
      if (isChecked) {
        checkedAddressId = val;
      }
      if (hasProvince && !personalAddressId) {
        personalAddressId = val;
      }
      if (!hasProvince && !butikAddressId) {
        butikAddressId = val;
      }
    }
  });

  // Pick best courier - prefer 1 (RPX) if available, else first valid
  let pickCourier = "";
  const availableCouriers: string[] = [];
  $checkout('input[name="pickCourier"]').each((_, el) => {
    const val = String($checkout(el).attr("value") || "");
    if (val) {
      availableCouriers.push(val);
      if (!pickCourier) {
        pickCourier = val;
      }
    }
  });
  // Try courier 1 (RPX) first if available
  if (availableCouriers.includes("1")) {
    pickCourier = "1";
  }

  // Decide which address to use:
  //  - If only courier 2 available → pickup butik → use butik address
  //  - Otherwise → ekspedisi → use personal address (or checked)
  const isPickupOnly = availableCouriers.length === 1 && availableCouriers[0] === "2";
  let addressId = "";
  if (isPickupOnly) {
    addressId = butikAddressId || checkedAddressId || personalAddressId;
  } else {
    addressId = checkedAddressId || personalAddressId || butikAddressId;
  }

  if (!addressId) {
    throw new Error("No valid shipping address found on checkout page");
  }

  logger.info(
    `[HTTP-Checkout] Using address ID: ${addressId} (mode: ${isPickupOnly ? "pickup-butik" : "ekspedisi"})`,
  );

  logger.info(
    `[HTTP-Checkout] Available couriers: [${availableCouriers.join(", ")}], picked: ${pickCourier}`,
  );

  let $form = $checkout; // Use to serialize form data; refreshed after shipping costs
  let validCouriers: string[] = [];
  let courierDiscounts: Record<string, string> = {};

  // For ekspedisi mode: must call get-shipping-costs AJAX first (server requires this before submit)
  if (!isPickupOnly) {
    const $addr = $checkout(`input[name="shippingAddress"][value="${addressId}"]`);
    const cityCode = $addr.attr("city_code") || "";
    const zipCode = $addr.attr("zip_code") || "";
    const weight = $addr.attr("weight") || "10";
    const quantity = $addr.attr("quantity") || "1";
    const grandtotal = $addr.attr("grandtotal") || "0";
    const idProvince = $addr.attr("id_province") || "";
    const idCity = $addr.attr("id_city") || "";
    const idDistrict = $addr.attr("id_district") || "";
    const address = $addr.attr("address") || "";

    // Extract butik code from hidden field or URL
    const butikCode = $checkout('input#butik_code').attr('value') ||
      $checkout('form#geoloc-change-location input[name="location"]').attr('value') || 'ABDH';

    const shippingUrl = `${BASE_URL}/id/get-shipping-costs/${butikCode}/${cityCode}/${weight}/${quantity}/${grandtotal}/${zipCode}/${idProvince}/${idCity}/${idDistrict}/${address}`;
    logger.info(`[HTTP-Checkout] Fetching shipping costs...`);
    try {
      const shippingResp = await client.get(shippingUrl, {
        headers: {
          "X-Requested-With": "XMLHttpRequest",
          "Referer": CHECKOUT_URL,
          "Accept": "application/json, text/javascript, */*; q=0.01",
          "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
        },
      });
      const shippingData = shippingResp.data as Record<string, number>;
      logger.info(`[HTTP-Checkout] Shipping costs response: ${JSON.stringify(shippingData)}`);

      // Only use couriers with cost > 0
      for (const c of availableCouriers) {
        const cost = shippingData[c];
        const discount = shippingData[`${c}_discount`] || 0;
        if (cost && cost > 0) {
          validCouriers.push(c);
          courierDiscounts[c] = String(discount);
        }
      }
      logger.info(`[HTTP-Checkout] Valid couriers (cost > 0): [${validCouriers.join(", ")}]`);
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : String(e);
      logger.warn(`[HTTP-Checkout] Shipping costs fetch failed: ${errMsg}`);
      validCouriers = availableCouriers;
    }

    if (validCouriers.length === 0) {
      return {
        success: false,
        items: addedItems,
        error: "No valid courier available for this address",
        elapsedMs: Date.now() - startTime,
      };
    }

    // Re-fetch checkout page to get fresh CSRF token (server may regenerate after shipping cost call)
    logger.info("[HTTP-Checkout] Re-fetching checkout page for fresh CSRF...");
    const freshCheckoutResp = await client.get<string>(CHECKOUT_URL);
    const freshCheckoutHtml = freshCheckoutResp.data;
    $form = cheerio.load(freshCheckoutHtml);
    const freshToken = extractCsrfToken(freshCheckoutHtml);
    logger.info(`[HTTP-Checkout] Old token: ${csrfToken}, Fresh token: ${freshToken}`);
    csrfToken = freshToken || csrfToken;
  }

  // Try submitting with each valid courier until one succeeds
  // For ekspedisi mode: only use couriers with shipping cost > 0
  // For pickup mode: use all available couriers (typically just courier 2)
  const couriersToTry = !isPickupOnly && validCouriers.length > 0
    ? validCouriers
    : [pickCourier, ...availableCouriers.filter((c) => c !== pickCourier)];

  logger.info(`[HTTP-Checkout] Will try couriers in order: [${couriersToTry.join(", ")}]`);

  for (const courier of couriersToTry) {
    // Build form data by serializing the actual form (preserving all hidden fields)
    const checkoutFormData = new URLSearchParams();

    // Start with all hidden inputs from form#checkout-form
    $form('#checkout-form input[type="hidden"]').each((_, el) => {
      const $el = $form(el);
      const name = $el.attr("name");
      const value = $el.attr("value") ?? "";
      if (name) {
        checkoutFormData.append(name, value);
      }
    });

    // Override / set required fields
    checkoutFormData.set("_token", csrfToken);
    checkoutFormData.set("tax_type", "PPH22");
    checkoutFormData.set("pickCourier", courier);
    checkoutFormData.set("pickPayment", "BMRI");
    checkoutFormData.set("pickLocation", "1");
    checkoutFormData.set("shippingAddress", addressId);
    checkoutFormData.set("valDiscount", courierDiscounts[courier] || "0");
    checkoutFormData.set("confirmCheckout", "1");
    // Selected address (hidden field that JS sets on change)
    checkoutFormData.set("selected_address", `sa-${
      $form(`input[name="shippingAddress"][value="${addressId}"]`).attr("id")?.replace("sa-", "") || "1"
    }`);

    logger.info(
      `[HTTP-Checkout] Step 4: Submitting checkout (courier=${courier}, payment=BMRI, address=${addressId})...`,
    );
    logger.debug(`[HTTP-Checkout] Form data: ${checkoutFormData.toString()}`);

    let checkoutResult;
    try {
      checkoutResult = await client.post(
        CHECKOUT_SUBMIT_URL,
        checkoutFormData.toString(),
        {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "Referer": CHECKOUT_URL,
            "Origin": BASE_URL,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
            "Upgrade-Insecure-Requests": "1",
            "Sec-Fetch-Dest": "document",
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Site": "same-origin",
            "Sec-Fetch-User": "?1",
          },
          maxRedirects: 10,
          validateStatus: () => true, // accept all status codes
        },
      );
    } catch (postErr) {
      const errMsg = postErr instanceof Error ? postErr.message : String(postErr);
      logger.warn(`[HTTP-Checkout] Courier ${courier} POST failed: ${errMsg} - trying next...`);
      continue;
    }

    logger.info(
      `[HTTP-Checkout] Response: status=${checkoutResult.status}, content-type=${checkoutResult.headers['content-type']}, length=${String(checkoutResult.data).length}`,
    );

    const finalHtml = checkoutResult.data as string;
    const finalUrl = checkoutResult.request?.res?.responseUrl || CHECKOUT_SUBMIT_URL;
    logger.info(`[HTTP-Checkout] Final URL: ${finalUrl}`);

    // Check for error - actual server error is "Pemesanan gagal diproses"
    // (text "diluar jangkauan" is in static JS modal template, not real error)
    const orderFailed = finalHtml.includes("Pemesanan gagal diproses") ||
      finalHtml.includes("Terjadi kesalahan pada pemesanan");
    const stillOnCheckout = finalUrl.includes("/id/checkout") && !finalUrl.includes("/order");

    if (orderFailed) {
      logger.warn(
        `[HTTP-Checkout] Courier ${courier} failed: "Pemesanan gagal diproses" - trying next...`,
      );
      // Save debug HTML for first failure
      if (config.debugScreenshotOnError) {
        const debugPath = path.join(
          config.debugDir,
          `http-checkout-courier-${courier}-${Date.now()}.html`,
        );
        await fs.mkdir(config.debugDir, { recursive: true });
        await fs.writeFile(debugPath, finalHtml, "utf-8");
        logger.info(`[HTTP-Checkout] Debug HTML saved: ${debugPath}`);
      }
      continue;
    }
    if (stillOnCheckout && !orderFailed) {
      logger.info(`[HTTP-Checkout] Still on checkout page - parsing for VA anyway...`);
    }

    // Try to extract VA
    let vaNumber = "";
    let orderNumber = "";
    let totalAmount = "";

    const vaMatch = finalHtml.match(
      /(?:Bank\s+Mandiri|Virtual\s+Account|Pembayaran\s+Via\s+Bank\s+Mandiri)[:\s]*(\d{10,20})/i,
    );
    if (vaMatch) vaNumber = vaMatch[1];

    const orderMatch = finalHtml.match(/(LMA\d+)/);
    if (orderMatch) orderNumber = orderMatch[1];

    const totalMatch = finalHtml.match(/Total\s+pembelian\s*:\s*(Rp[\s\d.,]+)/i);
    if (totalMatch) totalAmount = totalMatch[1].trim();

    const elapsedMs = Date.now() - startTime;

    if (vaNumber) {
      logger.info(`[HTTP-Checkout] ✓ SUCCESS in ${elapsedMs}ms - VA: ${vaNumber}`);
      return {
        success: true,
        vaNumber,
        orderNumber,
        totalAmount,
        items: addedItems,
        elapsedMs,
      };
    }

    // Order page reached but VA not parseable yet - save debug + return partial info
    if (config.debugScreenshotOnError) {
      const debugPath = path.join(
        config.debugDir,
        `http-checkout-${Date.now()}.html`,
      );
      await fs.mkdir(config.debugDir, { recursive: true });
      await fs.writeFile(debugPath, finalHtml, "utf-8");
      logger.info(`[HTTP-Checkout] Debug HTML saved: ${debugPath}`);
    }

    return {
      success: false,
      items: addedItems,
      error: "VA number not found in response",
      elapsedMs,
    };
  }

  // All couriers failed - try Playwright fallback
  logger.warn("[HTTP-Checkout] All couriers failed, falling back to Playwright checkout...");
  return completeCheckoutWithPlaywright(config, addedItems, startTime);
}
