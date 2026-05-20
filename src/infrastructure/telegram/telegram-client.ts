import { logger } from '../../app/utils/logger';
import { sleep } from '../../app/utils/retry';

/**
 * Sends a message to Telegram chat.
 */
export async function sendTelegramMessage(
  message: string,
  botToken: string,
  chatId: string,
): Promise<void> {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

  const payload = {
    chat_id: chatId,
    text: message,
    parse_mode: 'HTML',
  };

  const MAX_ATTEMPTS = 3;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (response.status === 429) {
      const body = (await response.json().catch(() => ({}))) as {
        parameters?: { retry_after?: number };
      };
      const retryAfter = body.parameters?.retry_after ?? 30;
      logger.warn(`[Telegram] Rate limited. Waiting ${retryAfter}s...`);
      await sleep(retryAfter * 1_000);
      continue;
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`[Telegram] HTTP ${response.status}: ${body}`);
    }

    logger.info('[Telegram] Message sent successfully');
    return;
  }

  throw new Error(`[Telegram] Failed after ${MAX_ATTEMPTS} attempts`);
}

/**
 * Sends checkout success notification with VA details.
 * VA number is wrapped in <code> so Telegram renders it as tap-to-copy.
 */
export async function sendCheckoutNotification(
  vaNumber: string,
  items: string[],
  totalAmount: string | undefined,
  orderNumber: string | undefined,
  botToken: string,
  chatId: string,
  extras?: { deadline?: string; shipping?: string },
): Promise<void> {
  const now = new Date().toLocaleString('id-ID', {
    timeZone: 'Asia/Jakarta',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  // Format items as a bullet list. Each entry can be "Emas Batangan - 10 gr x3" or just "10gr".
  const itemsBlock =
    items.length > 0
      ? items.map((i) => `  • ${i}`).join('\n')
      : '  • -';

  const lines = [
    '🎉 <b>CHECKOUT BERHASIL!</b>',
    '',
    `🧾 <b>Order:</b> ${orderNumber ? `#${orderNumber}` : '-'}`,
    '',
    '📦 <b>Produk:</b>',
    itemsBlock,
    '',
  ];

  if (extras?.shipping) {
    lines.push(`🚚 <b>Kurir:</b> ${extras.shipping}`);
  }
  lines.push(`💰 <b>Total Bayar:</b> ${totalAmount || '-'}`);
  lines.push('');
  lines.push('🏦 <b>VA Bank Mandiri</b> (tap untuk copy):');
  lines.push(`<code>${vaNumber}</code>`);

  if (extras?.deadline) {
    lines.push('');
    lines.push(`⏰ <b>Bayar sebelum:</b> ${extras.deadline}`);
  }

  lines.push('');
  lines.push(`🕐 ${now} WIB`);

  await sendTelegramMessage(lines.join('\n'), botToken, chatId);
}

/**
 * Sends checkout failure notification.
 */
export async function sendCheckoutFailureNotification(
  error: string,
  botToken: string,
  chatId: string,
): Promise<void> {
  const now = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });

  const message = [
    '❌ <b>CHECKOUT GAGAL</b>',
    '',
    `<b>Error:</b> ${error}`,
    '',
    `🕐 ${now}`,
  ].join('\n');

  await sendTelegramMessage(message, botToken, chatId);
}

/**
 * Sends an alert when the session has expired and needs manual login.
 */
export async function sendSessionExpiredAlert(
  botToken: string,
  chatId: string,
): Promise<void> {
  const now = new Date().toLocaleString('id-ID', {
    timeZone: 'Asia/Jakarta',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  const message = [
    '🔐 <b>SESSION EXPIRED</b>',
    '',
    'Session login Logam Mulia sudah expired.',
    '',
    'Jalankan: <code>npm run dev:login</code>',
    'Atau buka browser dan login manual.',
    '',
    `🕐 ${now} WIB`,
  ].join('\n');

  await sendTelegramMessage(message, botToken, chatId);
}
