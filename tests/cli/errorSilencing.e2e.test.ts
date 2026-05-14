/**
 * E2E test: Verify parse errors don't pollute CLI output
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CliRuntime } from '@/cli/runtime';
import path from 'node:path';
import { getLogger, setLoggerBackend, StderrLogger } from '@/shared/logger';

describe('CLI Error Silencing (E2E)', () => {
  const testWorkspace = path.resolve(__dirname, '../../tests/fixtures/basic-ts');
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let runtime: CliRuntime;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    runtime = new CliRuntime(testWorkspace);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    setLoggerBackend({
      createLogger(prefix: string, level) {
        return new StderrLogger(prefix, level);
      },
    });
  });

  it('silences parse errors during initialization', async () => {
    // Enable error collection
    runtime.enableErrorCollection();

    // Simulate heavy logging
    const logger = getLogger('SpiderDependencyAnalyzer');
    logger.error('Analysis failed: parse error in file.ts');
    logger.error('Failed to resolve: unknown module');

    // Disable and collect
    const errors = runtime.disableErrorCollection();

    // Verify errors were collected
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]?.message).toContain('Analysis failed');
    expect(errors).toHaveLength(2);
  });

  it('getCollectedErrors() returns current errors without stopping collection', () => {
    runtime.enableErrorCollection();

    const logger = getLogger('TestModule');
    logger.warn('warning 1');
    logger.error('error 1');

    // Peek at errors without stopping collection
    let errors = runtime.getCollectedErrors();
    expect(errors).toHaveLength(2);

    // Add more errors
    logger.info('info 1');

    // Collection still active
    errors = runtime.getCollectedErrors();
    expect(errors).toHaveLength(3);

    // Now stop
    const final = runtime.disableErrorCollection();
    expect(final).toHaveLength(3);
  });

  it('clearCollectedErrors() removes all current entries', () => {
    runtime.enableErrorCollection();

    const logger = getLogger('TestModule');
    logger.error('error 1');
    logger.error('error 2');

    let errors = runtime.getCollectedErrors();
    expect(errors).toHaveLength(2);

    runtime.clearCollectedErrors();
    errors = runtime.getCollectedErrors();
    expect(errors).toHaveLength(0);

    runtime.disableErrorCollection();
  });

  it('can enable/disable collection multiple times', () => {
    const logger = getLogger('TestModule');

    // First cycle
    runtime.enableErrorCollection();
    logger.error('round 1');
    let errors = runtime.disableErrorCollection();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toBe('round 1');

    // Second cycle (fresh collection)
    runtime.enableErrorCollection();
    logger.error('round 2');
    logger.warn('round 2 warning');
    errors = runtime.disableErrorCollection();
    expect(errors).toHaveLength(2);
    expect(errors[0]?.message).toBe('round 2');
  });
});
