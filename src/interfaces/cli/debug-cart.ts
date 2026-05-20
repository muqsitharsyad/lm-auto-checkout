import axios from 'axios';
import { CookieJar } from 'tough-cookie';
import { wrapper } from 'axios-cookiejar-support';
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

  const cartResp = await client.get('https://www.logammulia.com/id/my-cart');
  const html = cartResp.data as string;

  await fs.writeFile('data/debug/cart-dump.html', html, 'utf-8');
  console.log(`Cart HTML saved (${html.length} bytes)`);

  // Look for "Pcs" mentions and surrounding context
  const pcsMatches = Array.from(html.matchAll(/(\w+="[^"]+"[^>]*?){0,3}.{0,200}Pcs/gi)).slice(0, 5);
  console.log(`Found ${pcsMatches.length} "Pcs" mentions`);

  // Look for various ID patterns
  for (const pattern of [/id="(item\d+)"/g, /id="(cart-item-\d+)"/g, /data-item-id="(\d+)"/g, /data-id="([^"]+)"/g, /name="cart\[(\d+)\]/g]) {
    const matches = Array.from(html.matchAll(pattern));
    console.log(`Pattern ${pattern}: ${matches.length} matches`);
    if (matches.length > 0) console.log(`  Sample: ${matches[0][0]}`);
  }

  // Search for typical cart row classes
  for (const cls of ['cart-item', 'ct-body', 'product-row', 'item-row', 'cart-product']) {
    const count = (html.match(new RegExp(`class="[^"]*${cls}[^"]*"`, 'g')) || []).length;
    if (count) console.log(`Class .${cls}: ${count} occurrences`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });