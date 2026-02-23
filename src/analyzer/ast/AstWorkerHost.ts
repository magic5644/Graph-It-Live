/**
 * AstWorkerHost - Manages the AST Worker Thread lifecycle
 * 
 * Provides a Promise-based API for communicating with the AstWorker.
 * Handles worker spawning, message routing, and error handling.
 * 
 * CRITICAL: This module is completely VS Code agnostic!
 * NO import * as vscode from 'vscode' allowed!
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import { getLogger } from '../../shared/logger';
import type {
  InterfaceMemberInfo,
  SignatureComparisonResult,
  SignatureInfo,
  TypeAliasInfo,
} from '../SignatureAnalyzer';
import type { SymbolDependency, SymbolInfo } from '../types';

const log = getLogger('AstWorkerHost');

// Message types matching AstWorker
type WorkerRequest =
  | { type: 'analyzeFile'; id: number; filePath: string; content: string }
  | { type: 'getInternalExportDeps'; id: number; filePath: string; content: string }
  | { type: 'extractSignatures'; id: number; filePath: string; content: string }
  | { type: 'extractInterfaceMembers'; id: number; filePath: string; content: string }
  | { type: 'extractTypeAliases'; id: number; filePath: string; content: string }
  | { type: 'compareSignatures'; id: number; oldSig: SignatureInfo; newSig: SignatureInfo }
  | { type: 'analyzeBreakingChanges'; id: number; filePath: string; oldContent: string; newContent: string }
  | { type: 'reset'; id: number }
  | { type: 'getFileCount'; id: number };

type WorkerResponse =
  | { type: 'success'; id: number; result: unknown }
  | { type: 'error'; id: number; error: string; stack?: string };

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

/**
 * Host for the AST Worker - provides a Promise-based API
 */
export class AstWorkerHost {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private readonly workerPath: string;
  private readonly extensionPath?: string;

  /**
   * @param workerPath - Absolute path to the compiled astWorker.js bundle
   * @param extensionPath - Absolute path to the extension directory (for WASM files)
   */
  constructor(workerPath?: string, extensionPath?: string) {
    this.extensionPath = extensionPath;
    // Default to dist/astWorker.js relative to __dirname
    // When running from dist/extension.js: __dirname = dist/, so look for ./astWorker.js
    // When running from src/analyzer/ast/: __dirname = src/analyzer/ast/, so look for ../../../dist/astWorker.js
    // When running from tests: __dirname = out-webview/tests/analyzer/, so look for ../../../dist/astWorker.js
    
    if (workerPath) {
      this.workerPath = workerPath;
    } else {
      // Try multiple paths in order of likelihood
      const possiblePaths = [
        // Same directory (when bundled, all files are in dist/)
        path.join(__dirname, 'astWorker.js'),
        // From src/analyzer/ast/ -> dist/
        path.join(__dirname, '../../../dist/astWorker.js'),
        // From out-webview/src/analyzer/ast/ -> dist/
        path.join(__dirname, '../../../../dist/astWorker.js'),
        // Absolute fallback to project root
        path.join(process.cwd(), 'dist/astWorker.js'),
      ];

      let foundPath = '';
      for (const candidatePath of possiblePaths) {
        if (fs.existsSync(candidatePath)) {
          foundPath = candidatePath;
          break;
        }
      }

      // If still not found, use the most common path and let it fail with a clear error
      this.workerPath = foundPath || path.join(process.cwd(), 'dist/astWorker.js');
    }
  }

  /**
   * Initialize the worker thread
   */
  public async start(): Promise<void> {
    if (this.worker) {
      log.warn('AstWorker already started');
      return;
    }

    log.info(`Starting AstWorker from ${this.workerPath}`);

    try {
      this.worker = new Worker(this.workerPath, {
        workerData: { extensionPath: this.extensionPath },
      });

      this.worker.on('message', (response: WorkerResponse) => {
        this.handleResponse(response);
      });

      this.worker.on('error', (error: Error) => {
        log.error('AstWorker error:', error);
        // Reject all pending requests
        for (const [id, pending] of this.pendingRequests) {
          pending.reject(new Error(`AstWorker crashed: ${error.message}`));
          this.pendingRequests.delete(id);
        }
      });

      this.worker.on('exit', (code: number) => {
        if (code !== 0) {
          log.error(`AstWorker exited with code ${code}`);
        }
        this.worker = null;
      });

      log.info('AstWorker started successfully');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error(`Failed to start AstWorker: ${message}`);
      throw new Error(`Failed to start AstWorker: ${message}`, { cause: error });
    }
  }

  /**
   * Stop the worker thread
   */
  public async stop(): Promise<void> {
    if (!this.worker) {
      return;
    }

    log.info('Stopping AstWorker');

    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests) {
      pending.reject(new Error('AstWorker stopped'));
      this.pendingRequests.delete(id);
    }

    await this.worker.terminate();
    this.worker = null;

    log.info('AstWorker stopped');
  }

  /**
   * Analyze a file to extract symbols and dependencies
   */
  public async analyzeFile(
    filePath: string,
    content: string
  ): Promise<{ symbols: SymbolInfo[]; dependencies: SymbolDependency[] }> {
    const result = await this.sendRequest({
      type: 'analyzeFile',
      id: 0, // will be set by sendRequest
      filePath,
      content,
    });
    return result as { symbols: SymbolInfo[]; dependencies: SymbolDependency[] };
  }

  /**
   * Get internal export dependency graph
   */
  public async getInternalExportDependencyGraph(
    filePath: string,
    content: string
  ): Promise<Map<string, Set<string>>> {
    const result = await this.sendRequest({
      type: 'getInternalExportDeps',
      id: 0,
      filePath,
      content,
    });
    // Convert plain object back to Map<string, Set<string>>
    const obj = result as Record<string, string[]>;
    return new Map(Object.entries(obj).map(([k, v]) => [k, new Set(v)]));
  }

  /**
   * Extract function/method signatures
   */
  public async extractSignatures(filePath: string, content: string): Promise<SignatureInfo[]> {
    const result = await this.sendRequest({
      type: 'extractSignatures',
      id: 0,
      filePath,
      content,
    });
    return result as SignatureInfo[];
  }

  /**
   * Extract interface members
   */
  public async extractInterfaceMembers(
    filePath: string,
    content: string
  ): Promise<Map<string, InterfaceMemberInfo[]>> {
    const result = await this.sendRequest({
      type: 'extractInterfaceMembers',
      id: 0,
      filePath,
      content,
    });
    // Convert plain object back to Map
    const obj = result as Record<string, InterfaceMemberInfo[]>;
    return new Map(Object.entries(obj));
  }

  /**
   * Extract type aliases
   */
  public async extractTypeAliases(filePath: string, content: string): Promise<TypeAliasInfo[]> {
    const result = await this.sendRequest({
      type: 'extractTypeAliases',
      id: 0,
      filePath,
      content,
    });
    return result as TypeAliasInfo[];
  }

  /**
   * Compare two signatures
   */
  public async compareSignatures(
    oldSig: SignatureInfo,
    newSig: SignatureInfo
  ): Promise<SignatureComparisonResult> {
    const result = await this.sendRequest({
      type: 'compareSignatures',
      id: 0,
      oldSig,
      newSig,
    });
    return result as SignatureComparisonResult;
  }

  /**
   * Analyze breaking changes between old and new file content
   */
  public async analyzeBreakingChanges(
    filePath: string,
    oldContent: string,
    newContent: string
  ): Promise<SignatureComparisonResult[]> {
    const result = await this.sendRequest({
      type: 'analyzeBreakingChanges',
      id: 0,
      filePath,
      oldContent,
      newContent,
    });
    return result as SignatureComparisonResult[];
  }

  /**
   * Reset the ts-morph project to free memory
   */
  public async reset(): Promise<void> {
    await this.sendRequest({
      type: 'reset',
      id: 0,
    });
  }

  /**
   * Get the number of files in the ts-morph project
   */
  public async getFileCount(): Promise<number> {
    const result = await this.sendRequest({
      type: 'getFileCount',
      id: 0,
    });
    return result as number;
  }

  /**
   * Send a request to the worker and wait for response
   */
  private async sendRequest(request: Partial<WorkerRequest> & { type: string }): Promise<unknown> {
    // Auto-start worker on first request
    if (!this.worker) {
      await this.start();
    }

    const id = this.nextId++;
    const fullRequest = { ...request, id } as WorkerRequest;

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      this.worker?.postMessage(fullRequest);
    });
  }

  /**
   * Handle response from worker
   */
  private handleResponse(response: WorkerResponse): void {
    const pending = this.pendingRequests.get(response.id);
    if (!pending) {
      log.warn(`Received response for unknown request ${response.id}`);
      return;
    }

    this.pendingRequests.delete(response.id);

    if (response.type === 'success') {
      pending.resolve(response.result);
    } else {
      const error = new Error(response.error);
      if (response.stack) {
        error.stack = response.stack;
      }
      pending.reject(error);
    }
  }
}
