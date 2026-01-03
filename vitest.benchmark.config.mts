import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/benchmarks/**/*.bench.ts'],
    // Reduce log verbosity during benchmarks to avoid buffer overflow
    silent: false,
    reporter: 'default',
    benchmark: {
      include: ['tests/benchmarks/**/*.bench.ts'],
      reporters: ['default'], // Changed from 'verbose' to reduce stderr output
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
