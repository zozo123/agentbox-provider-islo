import { describe, expect, it, vi } from 'vitest';
import { statusCodeOf, withRetry } from './islo.js';

describe('islo retry helpers', () => {
  it('reads SDK and fetch-style status fields', () => {
    expect(statusCodeOf({ statusCode: 503 })).toBe(503);
    expect(statusCodeOf({ status: 429 })).toBe(429);
    expect(statusCodeOf(new Error('no status'))).toBeUndefined();
  });

  it('supports operation-specific retry windows', async () => {
    const op = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(Object.assign(new Error('settling'), { statusCode: 500 }))
      .mockRejectedValueOnce(Object.assign(new Error('settling'), { statusCode: 500 }))
      .mockResolvedValue('running');

    await expect(withRetry('resume', op, { backoffMs: [0, 0] })).resolves.toBe('running');
    expect(op).toHaveBeenCalledTimes(3);
  });

  it('does not retry a definite client error', async () => {
    const error = Object.assign(new Error('bad request'), { statusCode: 400 });
    const op = vi.fn<() => Promise<void>>().mockRejectedValue(error);

    await expect(withRetry('create', op, { backoffMs: [0, 0] })).rejects.toBe(error);
    expect(op).toHaveBeenCalledOnce();
  });
});
