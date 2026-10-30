import { describe, expect, it } from 'vitest';
import { mapWithConcurrency } from '@/shared/concurrency';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 1));

describe('mapWithConcurrency', () => {
  it('keeps item order whatever the completion order', async () => {
    const delays = [5, 1, 3, 0, 2];
    const result = await mapWithConcurrency(delays, 2, async (delay, index) => {
      await new Promise((resolve) => setTimeout(resolve, delay));
      return `${index}:${delay}`;
    });
    expect(result).toEqual(['0:5', '1:1', '2:3', '3:0', '4:2']);
  });

  it.each([
    [1, 1],
    [3, 3],
    [10, 5],
    [0, 1],
    [Number.NaN, 1],
  ])('runs at most min(limit=%s, items) calls at once (%s)', async (limit, expected) => {
    let running = 0;
    let peak = 0;
    await mapWithConcurrency([1, 2, 3, 4, 5], limit, async () => {
      running++;
      peak = Math.max(peak, running);
      await tick();
      running--;
    });
    expect(peak).toBe(expected);
  });

  it('returns an empty array for no items without calling fn', async () => {
    let calls = 0;
    expect(await mapWithConcurrency([], 4, async () => ++calls)).toEqual([]);
    expect(calls).toBe(0);
  });

  it('rejects with the first error and starts no new item after it', async () => {
    const started: number[] = [];
    await expect(
      mapWithConcurrency([0, 1, 2, 3, 4, 5], 2, async (item) => {
        started.push(item);
        if (item === 1) throw new Error('boom');
        await tick();
        return item;
      })
    ).rejects.toThrow('boom');
    expect(started).toEqual([0, 1]);
  });
});
