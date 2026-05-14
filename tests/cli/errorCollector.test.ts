/**
 * Test ErrorCollector silences parse errors during indexing
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ErrorCollectorBackend } from '@/cli/errorCollector';
import { setLoggerBackend, getLogger, StderrLogger } from '@/shared/logger';

describe('ErrorCollector', () => {
  let stderrWriteSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Spy on process.stderr.write to detect any output
    stderrWriteSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    stderrWriteSpy.mockRestore();
    // Restore normal logger
    setLoggerBackend({
      createLogger(prefix: string, level) {
        return new StderrLogger(prefix, level);
      },
    });
  });

  it('collects errors silently without writing to stderr', () => {
    const backend = new ErrorCollectorBackend();
    setLoggerBackend(backend);

    const logger = getLogger('TestModule');
    logger.error('Test parse error');
    logger.error('Another analysis failure');

    const entries = backend.getCollectedEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0]?.message).toBe('Test parse error');
    expect(entries[1]?.message).toBe('Another analysis failure');

    // Most importantly: stderr was NOT written to
    expect(stderrWriteSpy).not.toHaveBeenCalled();
  });

  it('collects multiple log levels', () => {
    const backend = new ErrorCollectorBackend();
    setLoggerBackend(backend);

    const logger = getLogger('TestModule');
    logger.debug('debug msg');
    logger.info('info msg');
    logger.warn('warn msg');
    logger.error('error msg');

    const entries = backend.getCollectedEntries();
    expect(entries).toHaveLength(4);
    expect(entries.map(e => e.level)).toEqual(['debug', 'info', 'warn', 'error']);
  });

  it('returns error count correctly', () => {
    const backend = new ErrorCollectorBackend();
    setLoggerBackend(backend);

    const logger = getLogger('TestModule');
    logger.warn('warning 1');
    logger.warn('warning 2');
    logger.error('error 1');

    const counts = backend.getErrorCount();
    expect(counts.errors).toBe(1);
    expect(counts.warnings).toBe(2);
    expect(counts.total).toBe(3);
  });

  it('clear() removes all entries', () => {
    const backend = new ErrorCollectorBackend();
    setLoggerBackend(backend);

    const logger = getLogger('TestModule');
    logger.error('msg 1');
    logger.error('msg 2');

    expect(backend.getCollectedEntries()).toHaveLength(2);
    backend.clear();
    expect(backend.getCollectedEntries()).toHaveLength(0);
  });
});
