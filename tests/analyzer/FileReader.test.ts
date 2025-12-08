import { describe, it, expect, beforeEach } from 'vitest';
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
