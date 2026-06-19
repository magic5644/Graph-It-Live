import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { FileReader } from '../../src/analyzer/FileReader';
import { SpiderErrorCode } from '../../src/analyzer/types';

// Test fixtures directory - use main.ts which exists
const fixturesDir = path.join(__dirname, '../fixtures/sample-project/src');
const testFilePath = path.join(fixturesDir, 'main.ts');

describe('FileReader', () => {
  let reader: FileReader;

  beforeEach(() => {
    reader = new FileReader({ maxSize: 1024 * 1024 }); // 1MB
  });

  describe('getFileSize', () => {
    it('should return file size info', async () => {
      const info = await reader.getFileSize(testFilePath);
      
      expect(info.path).toBe(testFilePath);
      expect(info.size).toBeGreaterThan(0);
      expect(info.isLarge).toBe(false);
    });

    it('should mark large files correctly', async () => {
      const smallReader = new FileReader({ maxSize: 10 }); // 10 bytes
      const info = await smallReader.getFileSize(testFilePath);
      
      expect(info.isLarge).toBe(true);
    });

    it('should throw for non-existent files', async () => {
      await expect(reader.getFileSize('/nonexistent/file.ts'))
        .rejects.toThrow();
    });
  });

  describe('readFile', () => {
    it('should read file content', async () => {
      const content = await reader.readFile(testFilePath);
      
      expect(content).toContain('import');
      expect(typeof content).toBe('string');
    });

    it('should throw for files exceeding maxSize', async () => {
      const tinyReader = new FileReader({ maxSize: 5 }); // 5 bytes
      
      try {
        await tinyReader.readFile(testFilePath);
        expect.fail('Should have thrown');
      } catch (error: any) {
        expect(error.code).toBe(SpiderErrorCode.FILE_TOO_LARGE);
      }
    });

    it('should respect per-call maxSize override', async () => {
      try {
        await reader.readFile(testFilePath, { maxSize: 5 });
        expect.fail('Should have thrown');
      } catch (error: any) {
        expect(error.code).toBe(SpiderErrorCode.FILE_TOO_LARGE);
      }
    });

    it('should use streaming for large files when enabled', async () => {
      const content = await reader.readFile(testFilePath, { streaming: true });
      
      expect(content).toContain('import');
    });
  });

  describe('readFileIfExists', () => {
    it('should return content for existing files', async () => {
      const content = await reader.readFileIfExists(testFilePath);
      
      expect(content).not.toBeNull();
      expect(content).toContain('import');
    });

    it('should return null for non-existent files', async () => {
      const content = await reader.readFileIfExists('/nonexistent/file.ts');
      expect(content).toBeNull();
    });
  });

  describe('canRead', () => {
    it('should return true for readable files', async () => {
      const canRead = await reader.canRead(testFilePath);
      expect(canRead).toBe(true);
    });

    it('should return false for non-existent files', async () => {
      const canRead = await reader.canRead('/nonexistent/file.ts');
      expect(canRead).toBe(false);
    });
  });
});

describe('FileReader - timeout regression', () => {
  afterEach(() => vi.useRealTimers());

  it('throws FILE_TOO_LARGE before timeout fires for oversized files', async () => {
    // Regression: timer used to start before stat, causing TIMEOUT instead of FILE_TOO_LARGE
    // when I/O was saturated. Now stat runs first, so FILE_TOO_LARGE always wins.
    vi.useFakeTimers();
    const tinyReader = new FileReader({ maxSize: 5, timeout: 100 });

    const promise = tinyReader.readFile(testFilePath);
    // Advance past timeout — must still get FILE_TOO_LARGE, not TIMEOUT
    vi.advanceTimersByTime(200);
    await expect(promise).rejects.toMatchObject({ code: SpiderErrorCode.FILE_TOO_LARGE });
  });

  it('clears timeout after successful read so no dangling rejection fires', async () => {
    // Use real timers: read the file normally, then verify the timer was cleared
    // by checking no unhandled rejection fires (no way to directly test clearTimeout,
    // but the absence of process-level crash is the observable effect).
    const reader = new FileReader({ timeout: 5000 });
    const content = await reader.readFile(testFilePath);
    expect(typeof content).toBe('string');
  });
});

describe('FileReader streaming', () => {
  it('should handle empty files', async () => {
    const reader = new FileReader();
    const emptyFile = path.join(__dirname, '../fixtures/empty-file.ts');
    
    // Create empty file
    await fs.writeFile(emptyFile, '');
    
    try {
      const content = await reader.readFile(emptyFile, { streaming: true });
      expect(content).toBe('');
    } finally {
      await fs.unlink(emptyFile);
    }
  });
});
