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

  console.log('Step 1: Fetch purchase page...');
  const resp1 = await client.get<string>('https://www.logammulia.com/id/purchase/gold');
  const $1 = cheerio.load(resp1.data);
  const csrf = $1('meta[name="_token"]').attr('content');
  console.log('CSRF:', csrf);

  console.log('Step 2: Switch to ABDH...');
  try {
    const resp2 = await client.post(
      'https://www.logammulia.com/do-change-location',
      new URLSearchParams({ _token: csrf || '', location: 'ABDH' }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    console.log('Status:', resp2.status, 'data length:', String(resp2.data).length);
    if (typeof resp2.data === 'string' && resp2.data.length < 500) {
      console.log('Response data:', resp2.data);
    }
  } catch (e: any) {
    console.log('Error:', e.message, 'status:', e.response?.status);
  }

  console.log('Step 3: Re-fetch purchase page...');
  const resp3 = await client.get<string>('https://www.logammulia.com/id/purchase/gold');
  await fs.writeFile('data/debug/http-purchase-after-switch.html', resp3.data);
  const $ = cheerio.load(resp3.data);

  const userText = $('li.user-desktop').text().trim();
  console.log('User text:', userText.substring(0, 80));

  const butikCode = $('input#butik_code').attr('value');
  console.log('Butik code:', butikCode);

  // Look for stock rows
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

  // Check for 10gr
  console.log('Has 10 gr text:', resp3.data.includes('10 gr') || resp3.data.includes('10.0 gr'));
}

main().catch((err) => { console.error(err); process.exit(1); });
