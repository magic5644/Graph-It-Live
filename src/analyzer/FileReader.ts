import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import { SpiderError, SpiderErrorCode } from './types';
import { getLogger } from '../shared/logger';

const log = getLogger('FileReader');

/**
 * File reading options
 */
export interface FileReadOptions {
  /** Maximum file size in bytes (default: 5MB) */
  maxSize?: number;
  /** Read in streaming mode for large files */
  streaming?: boolean;
  /** Chunk size for streaming (default: 64KB) */
  chunkSize?: number;
  /** Timeout in milliseconds (default: 30000) */
  timeout?: number;
}

/**
 * Result of file size check
 */
export interface FileSizeInfo {
  size: number;
  isLarge: boolean;
  path: string;
}

/** Default max file size: 5MB */
const DEFAULT_MAX_SIZE = 5 * 1024 * 1024;

/** Default chunk size: 64KB */
const DEFAULT_CHUNK_SIZE = 64 * 1024;

/** Default timeout: 30 seconds */
const DEFAULT_TIMEOUT = 30000;

/**
 * Safe file reader with size limits and streaming support
 * 
 * Features:
 * - Size checks before reading
 * - Streaming for large files (reduces memory pressure)
 * - Timeout protection
 * - Proper error classification
 */
export class FileReader {
  private readonly maxSize: number;
  private readonly chunkSize: number;
  private readonly timeout: number;

  constructor(options: FileReadOptions = {}) {
    this.maxSize = options.maxSize ?? DEFAULT_MAX_SIZE;
    this.chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT;
  }

  /**
   * Check file size without reading content
   */
  async getFileSize(filePath: string): Promise<FileSizeInfo> {
    try {
      const stats = await fs.stat(filePath);
      return {
        size: stats.size,
        isLarge: stats.size > this.maxSize,
        path: filePath,
      };
    } catch (error) {
      throw SpiderError.fromError(error, filePath);
    }
  }

  /**
   * Read file with size limit and optional streaming
   * 
   * @throws SpiderError with FILE_TOO_LARGE if file exceeds maxSize
   * @throws SpiderError with TIMEOUT if reading takes too long
   */
  async readFile(filePath: string, options?: FileReadOptions): Promise<string> {
    const maxSize = options?.maxSize ?? this.maxSize;
    const timeout = options?.timeout ?? this.timeout;
    const streaming = options?.streaming ?? false;

    // Create timeout promise
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new SpiderError(
          `File read timed out after ${timeout}ms: ${filePath}`,
          SpiderErrorCode.TIMEOUT,
          { filePath }
        ));
      }, timeout);
    });

    try {
      // Check size first
      const stats = await fs.stat(filePath);
      
      if (stats.size > maxSize) {
        throw new SpiderError(
          `File too large: ${filePath} (${this.formatSize(stats.size)} > ${this.formatSize(maxSize)})`,
          SpiderErrorCode.FILE_TOO_LARGE,
          { filePath }
        );
      }

      // Use streaming for files larger than 1MB
      if (streaming || stats.size > 1024 * 1024) {
        log.debug(`Streaming read for large file: ${filePath} (${this.formatSize(stats.size)})`);
        return await Promise.race([
          this.readFileStreaming(filePath),
          timeoutPromise,
        ]);
      }

      // Standard read for smaller files
      return await Promise.race([
        fs.readFile(filePath, 'utf-8'),
        timeoutPromise,
      ]);
    } catch (error) {
      if (error instanceof SpiderError) {
        throw error;
      }
      throw SpiderError.fromError(error, filePath);
    }
  }

  /**
   * Read file using streaming to reduce memory pressure
   */
  private async readFileStreaming(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      const stream = fsSync.createReadStream(filePath, {
        highWaterMark: this.chunkSize,
      });

      stream.on('data', (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });

      stream.on('end', () => {
        const content = Buffer.concat(chunks).toString('utf-8');
        resolve(content);
      });

      stream.on('error', (error) => {
        reject(SpiderError.fromError(error, filePath));
      });
    });
  }

  /**
   * Read file if it exists, return null otherwise
   */
  async readFileIfExists(filePath: string): Promise<string | null> {
    try {
      return await this.readFile(filePath);
    } catch (error) {
      if (error instanceof SpiderError && error.code === SpiderErrorCode.FILE_NOT_FOUND) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Check if file exists and is readable
   */
  async canRead(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath, fsSync.constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Format file size for human-readable display
   */
  private formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }
}
