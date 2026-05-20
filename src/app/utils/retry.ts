import { logger } from './logger';

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface RetryOptions {
  maxAttempts: number;
  delayMs: number;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
  description: string,
): Promise<T> {
  const { maxAttempts, delayMs } = options;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxAttempts) {
        logger.error(`[Retry] ${description} failed after ${maxAttempts} attempts`);
        throw err;
      }
      logger.warn(`[Retry] ${description} failed (attempt ${attempt}/${maxAttempts}), retrying in ${delayMs}ms...`);
      await sleep(delayMs);
    }
  }

  throw new Error(`[Retry] ${description} failed unexpectedly`);
}
