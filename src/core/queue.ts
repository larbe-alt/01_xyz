import { createLogger } from "../utils/logger.js";
import { retry } from "../utils/retry.js";
import { isRetryable } from "./errors.js";

const log = createLogger("core:queue");

export class WriteQueue {
  private chain: Promise<void> = Promise.resolve();
  private pending = 0;

  get depth(): number {
    return this.pending;
  }

  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    this.pending++;
    const task = this.chain.then(() =>
      retry(fn, {
        maxRetries: 3,
        baseDelayMs: 300,
        maxDelayMs: 5_000,
        shouldRetry: isRetryable,
      }),
    ).finally(() => { this.pending--; });
    this.chain = task.then(() => {}, () => {});
    return task;
  }

  async drain(): Promise<void> {
    await this.chain;
  }
}
