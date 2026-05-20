import { performHttpCheckout } from '../../infrastructure/logammulia/http-checkout-client';
import { getConfig } from '../../app/config/env';
import { logger } from '../../app/utils/logger';

async function main() {
  const config = getConfig();
  logger.setLevel('debug');
  const result = await performHttpCheckout(
    config.sessionFile,
    config.targetWeights,
    config,
    {
      location: 'BELM - Pengiriman Ekspedisi, Pulogadung Jakarta, Jakarta',
      locationCode: 'ABDH',
      items: [{ weight: '10 gr', qty: 1 }],
    },
  );
  console.log('=== RESULT ===');
  console.log(JSON.stringify(result, null, 2));
}
main().catch((err) => { console.error(err); process.exit(1); });
