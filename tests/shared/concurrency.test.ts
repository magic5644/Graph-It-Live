import { describe, expect, it } from 'vitest';
import { firstNonNull, firstNonNullConcurrent, mapWithConcurrency } from '@/shared/concurrency';

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

  it('rejects with the earliest failure in time, not the lowest index', async () => {
    await expect(
      mapWithConcurrency([0, 1], 2, async (item) => {
        if (item === 0) await new Promise((resolve) => setTimeout(resolve, 20));
        throw new Error(`failed ${item}`);
      })
    ).rejects.toThrow('failed 1');
  });
});

describe('firstNonNull', () => {
  it('returns the first non-null result in item order and stops there', async () => {
    const calls: number[] = [];
    const result = await firstNonNull([1, 2, 3, 4], async (item) => {
      calls.push(item);
      return item >= 2 ? `hit ${item}` : null;
    });
    expect(result).toBe('hit 2');
    expect(calls).toEqual([1, 2]);
  });

  it('keeps falsy non-null results', async () => {
    expect(await firstNonNull([0, 1], async (item) => item)).toBe(0);
    expect(await firstNonNull(['', 'a'], async (item) => item)).toBe('');
  });

  it('returns null for no items or no hit', async () => {
    expect(await firstNonNull([], async () => 'x')).toBeNull();
    expect(await firstNonNull([1, 2], async () => null)).toBeNull();
  });

  it('propagates a rejection and stops', async () => {
    const calls: number[] = [];
    await expect(firstNonNull([1, 2], async (item) => {
      calls.push(item);
      throw new Error(`boom ${item}`);
    })).rejects.toThrow('boom 1');
    expect(calls).toEqual([1]);
  });
});

describe('firstNonNullConcurrent', () => {
  it('starts every call and returns the first non-null result in item order', async () => {
    const calls: number[] = [];
    const result = await firstNonNullConcurrent([3, 1, 2], async (item) => {
      calls.push(item);
      await new Promise((resolve) => setTimeout(resolve, item));
      return item < 3 ? `hit ${item}` : null;
    });
    expect(result).toBe('hit 1');
    expect(calls).toEqual([3, 1, 2]);
  });

  it('keeps falsy non-null results and returns null without a hit', async () => {
    expect(await firstNonNullConcurrent([0, 1], async (item) => item)).toBe(0);
    expect(await firstNonNullConcurrent([], async () => 'x')).toBeNull();
    expect(await firstNonNullConcurrent([1, 2], async () => null)).toBeNull();
  });

  it('rejects when a call rejects', async () => {
    await expect(firstNonNullConcurrent([1, 2], async (item) => {
      if (item === 2) throw new Error('boom');
      return null;
    })).rejects.toThrow('boom');
  });
});
