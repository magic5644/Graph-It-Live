/** The part of a `vscode.CancellationToken` a wait reads: this module stays free of the vscode runtime. */
export interface CancelToken {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): { dispose(): void };
}

/**
 * Waits for `work` unless `token` is cancelled first: true once it settled, false on cancel.
 * Cancel stops the wait only; the work goes on (a shared index walk or build used by other views).
 * A failure of `work` before the cancel rejects.
 */
export function untilCancelled(work: Promise<unknown>, token?: CancelToken): Promise<boolean> {
  if (!token) return work.then(() => true);
  if (token.isCancellationRequested) {
    work.catch(() => {}); // the walk's own owner reports its failure
    return Promise.resolve(false);
  }
  return new Promise((resolve, reject) => {
    const subscription = token.onCancellationRequested(() => {
      subscription.dispose();
      resolve(false);
    });
    work.then(
      () => {
        subscription.dispose();
        resolve(true);
      },
      (error: unknown) => {
        subscription.dispose();
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
