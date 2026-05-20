import express from 'express';
import { logger } from '../../app/utils/logger';

export interface WebhookPayload {
  trigger: string;
  timestamp?: string;
  location?: string;
  locationCode?: string;
  items?: { weight: string; qty: number }[];
}

interface TriggerResult {
  success: boolean;
  message: string;
  vaNumber?: string;
  elapsedMs: number;
}

type CheckoutHandler = (payload?: WebhookPayload) => Promise<TriggerResult>;

/**
 * Lightweight webhook server for receiving checkout triggers.
 *
 * Endpoints:
 * - GET  /health   - Health check (for Docker/monitoring)
 * - GET  /status   - Service status
 * - POST /checkout - Trigger checkout (accepts optional stock payload)
 */
export function startWebhookServer(port: number, onCheckout: CheckoutHandler): void {
  const app = express();
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  app.get('/status', (_req, res) => {
    res.json({
      status: 'ready',
      service: 'lm-auto-checkout',
      mode: 'http-first',
      timestamp: new Date().toISOString(),
    });
  });

  app.post('/checkout', async (req, res) => {
    const payload = req.body as WebhookPayload | undefined;
    logger.info(
      `[Webhook] Checkout triggered${payload?.location ? ` (location: ${payload.location})` : ''}`,
    );

    try {
      const result = await onCheckout(payload);

      if (result.success) {
        logger.info(`[Webhook] ✓ ${result.message} (${result.elapsedMs}ms)`);
        res.json({
          success: true,
          message: result.message,
          vaNumber: result.vaNumber,
          elapsedMs: result.elapsedMs,
          timestamp: new Date().toISOString(),
        });
      } else {
        logger.warn(`[Webhook] ✗ ${result.message} (${result.elapsedMs}ms)`);
        res.status(400).json({
          success: false,
          error: result.message,
          elapsedMs: result.elapsedMs,
          timestamp: new Date().toISOString(),
        });
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error(`[Webhook] Error: ${errorMessage}`);
      res.status(500).json({
        success: false,
        error: errorMessage,
        timestamp: new Date().toISOString(),
      });
    }
  });

  app.listen(port, () => {
    logger.info(`[Webhook] Server listening on port ${port}`);
  });
}
