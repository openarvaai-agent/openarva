import { describe, expect, it } from 'vitest';
import { FixedWindowRateLimiter } from './rateLimit.js';

describe('fixed-window ingress rate limit', () => {
  it('limits a client and resets after the window', () => {
    const limiter = new FixedWindowRateLimiter(2, 1000);
    expect(limiter.allow('client-a', 100)).toBe(true);
    expect(limiter.allow('client-a', 200)).toBe(true);
    expect(limiter.allow('client-a', 300)).toBe(false);
    expect(limiter.allow('client-a', 1200)).toBe(true);
  });

  it('bounds client-key growth and denies missing client identity', () => {
    const limiter = new FixedWindowRateLimiter(10, 1000, 1);
    expect(limiter.allow('client-a', 100)).toBe(true);
    expect(limiter.allow('client-b', 100)).toBe(false);
    expect(limiter.allow('', 100)).toBe(false);
  });
});