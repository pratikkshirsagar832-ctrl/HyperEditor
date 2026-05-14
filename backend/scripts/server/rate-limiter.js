/**
 * Token-bucket rate limiter for external APIs (DeepSeek, Groq, GIPHY).
 * If the bucket is empty, the caller waits (promise) and retries with
 * exponential backoff up to `maxRetries` times.
 *
 * Usage:
 *   const limiter = new RateLimiter(1, 2000); // 1 token per 2 seconds
 *   await limiter.acquire();
 *   // call DeepSeek ...
 */

export class RateLimiter {
  /**
   * @param {number} maxTokens  - maximum burst (normally 1)
   * @param {number} refillMs   - how many ms to wait for 1 token
   */
  constructor(maxTokens = 1, refillMs = 2000) {
    this.maxTokens = maxTokens;
    this.refillMs = refillMs;
    this.tokens = maxTokens;
    this.lastRefill = Date.now();
    this.waitQueue = [];
  }

  _refill() {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const newTokens = Math.floor(elapsed / this.refillMs);
    if (newTokens > 0) {
      this.tokens = Math.min(this.maxTokens, this.tokens + newTokens);
      this.lastRefill = now;
    }
  }

  /**
   * Acquire a token. Returns a promise that resolves when a token is
   * available. Throws after `maxRetries` if the API keeps rejecting.
   *
   * @param {number} [maxRetries=3] max number of retries
   * @param {number} [baseDelayMs=1000] base exponential backoff delay
   */
  async acquire(maxRetries = 3, baseDelayMs = 1000) {
    let attempt = 0;
    while (attempt <= maxRetries) {
      this._refill();
      if (this.tokens > 0) {
        this.tokens--;
        return;
      }
      attempt++;
      if (attempt >= maxRetries) {
        throw new Error(`Rate limit: max retries (${maxRetries}) exceeded`);
      }
      // Wait for refill
      const waitMs = baseDelayMs * Math.pow(2, attempt - 1);
      await new Promise(r => setTimeout(r, waitMs));
    }
  }
}

import { createHash } from 'crypto';

/**
 * Hash a string with SHA-256.
 */
export function sha256(input) {
  return createHash('sha256').update(input).digest('hex');
}
