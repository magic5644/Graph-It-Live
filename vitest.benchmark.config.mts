import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import NoSummaryBenchmarkReporter from './scripts/noSummaryBenchmarkReporter';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/benchmarks/**/*.bench.ts'],
    // Benchmarks are very output-heavy; avoid interactive TTY summary rendering.
    silent: false,
    reporters: ['default'],
    benchmark: {
      include: ['tests/benchmarks/**/*.bench.ts'],
      // Use a custom reporter that disables SummaryReporter/WindowRenderer to avoid
      // RangeError: Invalid string length caused by TTY buffering.
      reporters: [new NoSummaryBenchmarkReporter()],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
