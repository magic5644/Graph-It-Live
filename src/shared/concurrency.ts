/**
 * Runs `fn` on every item with at most `limit` calls in flight and returns the results in item order.
 * Unlike fixed batches, a slow item never holds back the next ones. On the first rejection no new item
 * starts, and the promise rejects with that first error (in time) once the calls in flight settle.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failure: { error: unknown } | undefined;
  // Recursion, not a loop: each worker awaits its items one after another; the workers run in parallel.
  const worker = async (): Promise<void> => {
    const index = next++;
    if (failure || index >= items.length) return;
    try {
      results[index] = await fn(items[index], index);
    } catch (error) {
      failure ??= { error };
      return;
    }
    return worker();
  };
  const workers = Math.min(Math.max(1, Math.floor(limit) || 1), items.length);
  await Promise.all(Array.from({ length: workers }, worker));
  if (failure) throw failure.error;
  return results;
}

/**
 * First non-null result of `fn` over `items`, in item order. Calls run one at a time and stop at the
 * first hit: for lookups (file probes, nearest-first walks) where the first candidates usually match.
 */
export async function firstNonNull<T, R>(
  items: readonly T[],
  fn: (item: T) => Promise<R | null>,
  index = 0,
): Promise<R | null> {
  if (index >= items.length) return null;
  const result = await fn(items[index]);
  return result ?? firstNonNull(items, fn, index + 1);
}

/**
 * `firstNonNull`, but every call starts at once: for lookups that usually miss (all candidates get
 * probed anyway), where waiting on each call in turn only adds latency.
 */
export async function firstNonNullConcurrent<T, R>(
  items: readonly T[],
  fn: (item: T) => Promise<R | null>,
): Promise<R | null> {
  const results = await Promise.all(items.map(fn));
  return results.find((result) => result !== null) ?? null;
}
