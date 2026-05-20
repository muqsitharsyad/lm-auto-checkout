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

  console.log('Fetching purchase page...');
  const resp = await client.get<string>('https://www.logammulia.com/id/purchase/gold');
  const html = resp.data;

  await fs.writeFile('data/debug/http-purchase.html', html);
  console.log('Saved to data/debug/http-purchase.html');
  console.log('Size:', html.length, 'bytes');

  const $ = cheerio.load(html);

  const hasLogout = $('a[href*="/logout"]').length > 0;
  console.log('Logged in:', hasLogout);

  const locationSelect = $('select#location option:selected');
  console.log('Selected location:', locationSelect.text().trim(), '(value:', locationSelect.attr('value'), ')');

  // Find location info from header/page
  const userText = $('li.user-desktop').text().trim();
  console.log('User text:', userText.substring(0, 100));

  const rows = $('.cart-table .ct-body .ctr');
  console.log('Total stock rows:', rows.length);

  rows.each((i, row) => {
    const $row = $(row);
    const isDisabled = $row.hasClass('disabled');
    const hasNoStock = $row.find('span.no-stock').length > 0;
    const ngcText = $row.find('.ngc-text').first();
    const rawWeight = ngcText.contents().filter((_, n) => n.type === 'text').first().text().trim();
    const qtyInput = $row.find('input.qty');
    const maxQty = qtyInput.attr('max') || '0';
    const inputName = qtyInput.attr('name') || '';
    console.log(`  ${i}: weight="${rawWeight}" disabled=${isDisabled} noStock=${hasNoStock} maxQty=${maxQty} input=${inputName}`);
  });
}
main().catch((err) => { console.error(err); process.exit(1); });
