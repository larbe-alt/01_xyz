import { createLogger } from "./logger.js";

const log = createLogger("retry");

export interface RetryOpts {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  shouldRetry?: (err: unknown) => boolean;
}

export async function retry<T>(
  fn: () => Promise<T>,
  opts: RetryOpts = {},
): Promise<T> {
  const { maxRetries = 3, baseDelayMs = 500, maxDelayMs = 10_000, shouldRetry } = opts;

  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      if (attempt > maxRetries || (shouldRetry && !shouldRetry(err))) {
        throw err;
      }
      const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      log.warn(`Attempt ${attempt}/${maxRetries} failed, retrying in ${delay}ms`, {
        error: err instanceof Error ? err.message : String(err),
      });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}
