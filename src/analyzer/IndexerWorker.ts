/**
 * Worker Thread for background indexing
 * 
 * This runs in a separate thread to avoid blocking the VS Code extension host.
 * Node.js Worker Threads allow CPU-intensive work without affecting responsiveness.
 */

import { parentPort, workerData } from 'node:worker_threads';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Parser } from './Parser';
import { PathResolver } from './PathResolver';
import type { Dependency } from './types';
import { isSupportedSourceFile, shouldSkipDirectory } from './SourceFileFilters';

interface WorkerConfig {
  rootDir: string;
  maxDepth?: number;
  excludeNodeModules?: boolean;
  tsConfigPath?: string;
  progressInterval?: number;
}

interface WorkerMessage {
  type: 'start' | 'cancel';
}

interface WorkerResponse {
  type: 'progress' | 'complete' | 'error' | 'counting';
  data?: {
    processed?: number;
    total?: number;
    currentFile?: string;
    duration?: number;
    indexData?: IndexedFileData[];
  };
  error?: string;
}

interface IndexedFileData {
  filePath: string;
  dependencies: Dependency[];
  mtime: number;
  size: number;
}

let cancelled = false;

/**
 * Post a message to the parent thread
 */
function postMessage(msg: WorkerResponse): void {
  parentPort?.postMessage(msg);
}

/**
 * Collect all supported source files in a directory tree
 */
async function collectAllSourceFiles(dir: string, excludeNodeModules: boolean): Promise<string[]> {
  const files: string[] = [];
  
  const walkDir = async (currentDir: string): Promise<void> => {
    if (cancelled) return;

    try {
      const entries = await fs.readdir(currentDir, { withFileTypes: true });
      
      for (const entry of entries) {
        if (cancelled) return;

        const fullPath = path.join(currentDir, entry.name);
        
        if (entry.isDirectory()) {
          if (!shouldSkipDirectory(entry.name, excludeNodeModules)) {
            await walkDir(fullPath);
          }
        } else if (entry.isFile() && isSupportedSourceFile(entry.name)) {
          files.push(fullPath);
        }
      }
      } catch {
        // Silently skip directories that can't be read (permission denied, etc.)
      }
  };

  await walkDir(dir);
  return files;
}

/**
 * Analyze a single file and extract its dependencies
 */
async function analyzeFile(
  filePath: string,
  parser: Parser,
  resolver: PathResolver
): Promise<IndexedFileData | null> {
  try {
    const [content, stats] = await Promise.all([
      fs.readFile(filePath, 'utf-8'),
      fs.stat(filePath),
    ]);

    const parsedImports = parser.parse(content, filePath);
    const dependencies: Dependency[] = [];

    for (const imp of parsedImports) {
      const resolvedPath = await resolver.resolve(filePath, imp.module);
      if (resolvedPath) {
        dependencies.push({
          path: resolvedPath,
          type: imp.type,
          line: imp.line,
          module: imp.module,
        });
      }
    }

    return {
      filePath,
      dependencies,
      mtime: stats.mtimeMs,
      size: stats.size,
    };
  } catch {
    return null;
  }
}

/**
 * Main indexing function
 */
async function runIndexing(config: WorkerConfig): Promise<void> {
  const startTime = Date.now();
  const progressInterval = config.progressInterval ?? 100;
  
  try {
    // Create parser and resolver
    const parser = new Parser();
    const resolver = new PathResolver(
      config.tsConfigPath,
      config.excludeNodeModules ?? true,
      config.rootDir // workspaceRoot for package.json discovery
    );

    // Phase 1: Collect all files
    postMessage({ type: 'counting' });
    const files = await collectAllSourceFiles(config.rootDir, config.excludeNodeModules ?? true);
    
    if (cancelled) {
      postMessage({ type: 'complete', data: { duration: Date.now() - startTime, indexData: [] } });
      return;
    }

    const totalFiles = files.length;
    const indexedData: IndexedFileData[] = [];
    
    // Phase 2: Process files one by one
    // Since we're in a worker thread, we don't need to yield as aggressively
    // but we still send progress updates periodically
    for (let i = 0; i < files.length; i++) {
      if (cancelled) {
        break;
      }

      const result = await analyzeFile(files[i], parser, resolver);
      if (result) {
        indexedData.push(result);
      }

      // Send progress update periodically
      if ((i + 1) % progressInterval === 0 || i === files.length - 1) {
        postMessage({
          type: 'progress',
          data: {
            processed: i + 1,
            total: totalFiles,
            currentFile: files[i],
          },
        });
      }
    }

    const duration = Date.now() - startTime;
    postMessage({
      type: 'complete',
      data: {
        duration,
        processed: indexedData.length,
        total: totalFiles,
        indexData: indexedData,
      },
    });
  } catch (error) {
    postMessage({
      type: 'error',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

// Listen for messages from the parent thread
parentPort?.on('message', (msg: WorkerMessage) => {
  switch (msg.type) {
    case 'start':
      cancelled = false;
      runIndexing(workerData as WorkerConfig);
      break;
    case 'cancel':
      cancelled = true;
      break;
  }
});

// Export for testing
export type { WorkerConfig, WorkerMessage, WorkerResponse, IndexedFileData };
