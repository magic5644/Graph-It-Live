import { BenchmarkReporter } from 'vitest/node';

/**
 * Custom benchmark reporter that suppresses the interactive WindowRenderer /
 * SummaryReporter to avoid `RangeError: Invalid string length` caused by TTY
 * buffering when the benchmark result table is very large.
 */
export default class NoSummaryBenchmarkReporter extends BenchmarkReporter {
  constructor() {
    super({ summary: false });
  }

  override printTestModule() {
    // Suppress duplicate suite table output.
  }
}
