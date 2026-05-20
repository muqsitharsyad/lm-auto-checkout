import axios from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar, Cookie } from 'tough-cookie';
import * as cheerio from 'cheerio';
import fs from 'fs/promises';

async function main() {
  const sessionData = JSON.parse(await fs.readFile('data/session.json', 'utf-8'));
  const jar = new CookieJar();
  for (const cookie of sessionData.cookies || []) {
    const domain = cookie.domain || 'www.logammulia.com';
    if (!domain.includes('logammulia.com')) continue;
    const cleanDomain = domain.replace(/^\./, '');
    const setCookieUrl = `https://${cleanDomain}${cookie.path || '/'}`;
    try {
      const tc = new Cookie({
        key: cookie.name, value: cookie.value, domain: cleanDomain,
        path: cookie.path || '/', secure: cookie.secure || false, httpOnly: cookie.httpOnly || false,
      });
      await jar.setCookie(tc, setCookieUrl);
    } catch {}
  }

  const client = wrapper(axios.create({
    jar, withCredentials: true, timeout: 15000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    },
  }));

  console.log('Step 1: Fetch purchase page for CSRF...');
  const resp1 = await client.get<string>('https://www.logammulia.com/id/purchase/gold');
  const $1 = cheerio.load(resp1.data);
  const csrf = $1('meta[name="_token"]').attr('content') || '';
  console.log('CSRF:', csrf);

  console.log('Step 2: Clear cart...');
  try {
    const clearResp = await client.post(
      'https://www.logammulia.com/clear-cart',
      new URLSearchParams({ _token: csrf }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    console.log('Clear status:', clearResp.status);
  } catch (e: any) {
    console.log('Clear error:', e.message);
  }

  console.log('Step 3: Fetch cart to verify cleared...');
  const cartResp = await client.get<string>('https://www.logammulia.com/id/my-cart');
  const $cart = cheerio.load(cartResp.data);
  await fs.writeFile('data/debug/http-cart.html', cartResp.data);

  // Check cart contents
  const cartItems = $cart('.cart-table tr').length;
  console.log('Cart rows:', cartItems);
  const cartEmpty = cartResp.data.includes('Keranjang Anda Kosong') || cartResp.data.includes('cart-empty');
  console.log('Cart empty?', cartEmpty);
  const totalText = $cart('#order_total, .order-total').text().trim();
  console.log('Order total:', totalText);

  // Find empty cart indicator
  const emptyMsg = $cart('.empty-cart, .ngc-empty-state').text().trim();
  console.log('Empty msg:', emptyMsg.substring(0, 200));
}

main().catch((err) => { console.error(err); process.exit(1); });
