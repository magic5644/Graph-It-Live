/**
 * Runs `fn` on every item with at most `limit` calls in flight and returns the results in item order.
 * Unlike fixed batches, a slow item never holds back the next ones. On the first rejection no new item
 * starts, and the promise rejects with that error once the calls in flight settle.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  // Recursion, not a loop: each worker awaits its items one after another; the workers run in parallel.
  const worker = async (): Promise<void> => {
    const index = next++;
    if (failed || index >= items.length) return;
    try {
      results[index] = await fn(items[index], index);
    } catch (error) {
      failed = true;
      throw error;
    }
    return worker();
  };
  const workers = Math.min(Math.max(1, Math.floor(limit) || 1), items.length);
  const settled = await Promise.allSettled(Array.from({ length: workers }, worker));
  const rejected = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (rejected) throw rejected.reason;
  return results;
}
