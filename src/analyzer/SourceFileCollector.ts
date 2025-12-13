import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { getLogger } from '../shared/logger';

const log = getLogger('SourceFileCollector');

export interface SourceFileCollectorOptions {
  excludeNodeModules: boolean;
  yieldIntervalMs?: number;
  yieldCallback?: () => Promise<void>;
  isCancelled?: () => boolean;
}

/**
 * Walks the workspace tree and returns the list of supported source files.
 * Extracted from Spider to keep traversal/cancellation logic isolated.
 */
export class SourceFileCollector {
  private excludeNodeModules: boolean;
  private readonly yieldIntervalMs: number;
  private readonly yieldCallback: () => Promise<void>;
  private readonly isCancelled: () => boolean;

  constructor(options: SourceFileCollectorOptions) {
    this.excludeNodeModules = options.excludeNodeModules;
    this.yieldIntervalMs = options.yieldIntervalMs ?? 50;
    this.yieldCallback = options.yieldCallback ?? (async () => {});
    this.isCancelled = options.isCancelled ?? (() => false);
  }

  updateOptions(options: Partial<Pick<SourceFileCollectorOptions, 'excludeNodeModules'>>): void {
    if (options.excludeNodeModules !== undefined) {
      this.excludeNodeModules = options.excludeNodeModules;
    }
  }

  async collectAllSourceFiles(rootDir: string): Promise<string[]> {
    const files: string[] = [];
    let lastYieldTime = Date.now();

    const processEntry = async (entry: import('node:fs').Dirent, currentDir: string): Promise<void> => {
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory() && !this.shouldSkipDirectory(entry.name)) {
        await walkDir(fullPath);
      } else if (entry.isFile() && this.isSupportedSourceFile(entry.name)) {
        files.push(fullPath);
      }
    };

    const walkDir = async (currentDir: string): Promise<void> => {
      if (this.isCancelled()) {
        return;
      }

      const now = Date.now();
      if (now - lastYieldTime >= this.yieldIntervalMs) {
        await this.yieldCallback();
        lastYieldTime = Date.now();
      }

      try {
        const entries = await fs.readdir(currentDir, { withFileTypes: true });
        for (const entry of entries) {
          if (this.isCancelled()) {
            return;
          }
          await processEntry(entry, currentDir);
        }
      } catch (error) {
        log.error('Error reading directory', currentDir, error);
      }
    };

    await walkDir(rootDir);
    return files;
  }

  private shouldSkipDirectory(entryName: string): boolean {
    if (this.excludeNodeModules && entryName === 'node_modules') {
      return true;
    }
    return entryName.startsWith('.');
  }

  private isSupportedSourceFile(fileName: string): boolean {
    return /\.(ts|tsx|js|jsx|vue|svelte|gql|graphql)$/.test(fileName);
  }
}
