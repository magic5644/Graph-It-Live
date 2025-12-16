/**
 * Shared cancellation token for indexing operations (main thread + workers).
 */
export class SpiderIndexingCancellation {
  private cancelled = false;

  reset(): void {
    this.cancelled = false;
  }

  cancel(): void {
    this.cancelled = true;
  }

  isCancelled(): boolean {
    return this.cancelled;
  }
}

