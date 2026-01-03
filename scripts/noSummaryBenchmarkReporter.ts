import { BenchmarkReporter } from 'vitest/reporters';

export default class NoSummaryBenchmarkReporter extends BenchmarkReporter {
  constructor() {
    super({ summary: false });
  }

  override onTestSuiteResult(testSuite: Parameters<BenchmarkReporter['onTestSuiteResult']>[0]) {
    // Keep the benchmark table output, but avoid printing it twice.
    // Vitest calls both `onTestSuiteResult` and `printTestModule` during bench runs.
    super.onTestSuiteResult(testSuite);
    // `BenchmarkReporter` already prints the suite table in `onTestSuiteResult`.
  }

  override printTestModule() {
    // Suppress duplicate suite table output.
  }
}
