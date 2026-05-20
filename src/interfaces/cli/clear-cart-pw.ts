import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import fs from 'fs/promises';

chromium.use(StealthPlugin());

async function main() {
  const session = JSON.parse(await fs.readFile('data/session.json', 'utf-8'));

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    storageState: session,
  });
  const page = await context.newPage();

  console.log('Navigating to cart...');
  await page.goto('https://www.logammulia.com/id/my-cart', { waitUntil: 'domcontentloaded' });

  // Wait for cart to render
  await page.waitForTimeout(3000);

  // Find all remove buttons
  const removeBtnCount = await page.evaluate(() => {
    const links = document.querySelectorAll('a, button');
    let count = 0;
    for (const el of Array.from(links)) {
      const text = (el.textContent || '').toLowerCase();
      const onclick = el.getAttribute('onclick') || '';
      const href = el.getAttribute('href') || '';
      if (text.includes('hapus') || text.includes('remove') || text === '×' || onclick.includes('remove') || href.includes('remove')) {
        count++;
      }
    }
    return count;
  });
  console.log(`Found ${removeBtnCount} potential remove buttons`);

  // Try multiple cleanup methods inside browser context
  const cleared = await page.evaluate(async () => {
    const token = (document.querySelector('meta[name="_token"]') as HTMLMetaElement)?.content || '';
    if (!token) return 'no token';

    // Method 1: Click any visible "Hapus" / remove buttons
    const removed: string[] = [];
    const candidates = Array.from(document.querySelectorAll('a, button')) as HTMLElement[];
    for (const el of candidates) {
      const text = (el.textContent || '').trim().toLowerCase();
      const onclick = el.getAttribute('onclick') || '';
      if (text === 'hapus' || text === 'remove' || text === '×' || onclick.includes('remove')) {
        try {
          el.click();
          removed.push(text || onclick.slice(0, 40));
        } catch { /* ignore */ }
      }
    }

    // Wait a moment for clicks to process
    await new Promise(r => setTimeout(r, 1500));

    // Method 2: Loop /remove-cart for any remaining items
    for (let pass = 0; pass < 5; pass++) {
      const cartRes = await fetch('https://www.logammulia.com/id/my-cart', { credentials: 'include' });
      const html = await cartRes.text();
      const ids = Array.from(html.matchAll(/data-id="(\d+)"|id="(item\d+)"|name="cart\[(\d+)\]"|item-id="(\d+)"/g))
        .map(m => m[1] || m[2] || m[3] || m[4])
        .filter(Boolean);

      if (ids.length === 0) break;

      for (const id of ids) {
        await fetch('https://www.logammulia.com/remove-cart', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: '_token=' + encodeURIComponent(token) + '&itemId=' + encodeURIComponent(id),
          credentials: 'include',
        }).catch(() => {});
        removed.push(id);
      }
    }

    return { removed, removedCount: removed.length };
  });
  console.log('Clear result:', JSON.stringify(cleared, null, 2));

  // Reload cart and check
  await page.goto('https://www.logammulia.com/id/my-cart', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  const finalState = await page.evaluate(() => {
    const html = document.body.innerText;
    const itemCount = Array.from(document.querySelectorAll('[id^="item"]')).length;
    const totalMatch = html.match(/Total[\s\S]{0,100}?Rp\s*[\d.,]+/);
    return { itemCount, totalText: totalMatch ? totalMatch[0].slice(0, 100) : 'no total' };
  });
  console.log('Final cart state:', JSON.stringify(finalState, null, 2));

  console.log('\nBrowser will stay open 10s — verify the cart visually...');
  await page.waitForTimeout(10000);

  await browser.close();
  console.log('Done.');
}

main().catch((e) => { console.error(e); process.exit(1); });