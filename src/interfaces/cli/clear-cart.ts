import axios from 'axios';
import { CookieJar } from 'tough-cookie';
import { wrapper } from 'axios-cookiejar-support';
import * as cheerio from 'cheerio';
import fs from 'fs/promises';

async function main() {
  const raw = await fs.readFile('data/session.json', 'utf-8');
  const sessionData = JSON.parse(raw);

  const jar = new CookieJar();
  for (const c of sessionData.cookies || []) {
    try {
      const cleanDomain = (c.domain || '').replace(/^\./, '');
      const cookieStr = `${c.name}=${c.value}; Domain=${cleanDomain}; Path=${c.path || '/'}`;
      jar.setCookieSync(cookieStr, `https://${cleanDomain}${c.path || '/'}`);
    } catch { /* skip */ }
  }

  const client = wrapper(axios.create({
    jar,
    withCredentials: true,
    timeout: 15_000,
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  }));

  console.log('Fetching cart page...');
  const cartResp = await client.get('https://www.logammulia.com/id/my-cart');
  const html = cartResp.data as string;
  const $ = cheerio.load(html);
  const token = $('meta[name="_token"]').attr('content');

  if (!token) {
    console.error('No CSRF token — session expired?');
    process.exit(1);
  }

  const items: string[] = [];
  // Real cart structure: <a class="btn-remove-item" attr-cart="item3590141">
  for (const m of html.matchAll(/attr-cart="(item\d+)"/g)) items.push(m[1]);

  console.log(`Found ${items.length} cart items`);

  for (const cartId of items) {
    try {
      // Real payload: {cart: <id>, _token: ...} (NOT "itemId")
      await client.post(
        'https://www.logammulia.com/remove-cart',
        `cart=${encodeURIComponent(cartId)}&_token=${encodeURIComponent(token)}`,
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' } },
      );
      console.log(`✓ Removed ${cartId}`);
    } catch (e) {
      console.error(`✗ Failed ${cartId}:`, e instanceof Error ? e.message : e);
    }
  }

  // Verify
  const verifyResp = await client.get('https://www.logammulia.com/id/my-cart');
  const remaining = Array.from((verifyResp.data as string).matchAll(/attr-cart="(item\d+)"/g)).map(m => m[1]);
  console.log(`After cleanup: ${remaining.length} items remaining`);
  if (remaining.length > 0) console.log('  Remaining:', remaining);

  console.log('Done — cart empty.');
}

main().catch((e) => { console.error(e); process.exit(1); });
