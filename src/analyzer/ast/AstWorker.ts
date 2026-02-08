/**
 * AST Worker Thread - Isolates ts-morph from main extension bundle
 * 
 * This worker runs in a separate thread to avoid bundling ts-morph (12MB+) 
 * in extension.js and mcpWorker.js. All AST-based analysis (SymbolAnalyzer, 
 * SignatureAnalyzer) is delegated here.
 * 
 * ## WASM Parser Usage in Worker Threads
 *
 * This worker uses WASM-based parsers (PythonSymbolAnalyzer, RustSymbolAnalyzer) 
 * for symbol extraction from Python and Rust files. The parsers require the 
 * `extensionPath` to locate WASM files in the dist/ directory.
 *
 * **Current Implementation:**
 * - Worker receives `extensionPath` via `WorkerData`
 * - Passes `extensionPath` to symbol analyzer constructors
 * - Symbol analyzers initialize WASM from extension's dist/ directory
 * - WASM files: tree-sitter.wasm, tree-sitter-python.wasm, tree-sitter-rust.wasm
 *
 * **Known Limitations:**
 * - web-tree-sitter has known compatibility issues in Node.js Worker Thread contexts
 * - WASM initialization may fail with LinkError in some environments
 * - If WASM fails, symbol extraction errors will be caught and returned to caller
 *
 * **Alternative Approach (if WASM issues persist):**
 * If WASM parsing proves unreliable in worker threads, consider delegating parsing
 * to the extension host via message passing:
 * 1. Worker sends file path and content to extension host
 * 2. Extension host performs symbol analysis (WASM works reliably in Electron)
 * 3. Extension host sends extracted symbols back to worker
 * 4. Worker returns symbols to caller
 *
 * This would add message passing overhead but ensure reliable parsing.
 *
 * @see Requirements 5.3 - Support Electron Environment (workers delegate to extension host)
 * 
 * CRITICAL: This module is completely VS Code agnostic!
 * NO import * as vscode from 'vscode' allowed!
 */

import { parentPort, workerData } from 'node:worker_threads';
import { getLogger } from '../../shared/logger';
import { detectLanguageFromExtension } from '../../shared/utils/languageDetection';
import type { SignatureInfo } from '../SignatureAnalyzer';
import { SignatureAnalyzer } from '../SignatureAnalyzer';
import { SymbolAnalyzer } from '../SymbolAnalyzer';
import { PythonSymbolAnalyzer } from '../languages/PythonSymbolAnalyzer';
import { RustSymbolAnalyzer } from '../languages/RustSymbolAnalyzer';

// Worker data
interface WorkerData {
  /**
   * Path to the VS Code extension directory.
   * Required for WASM parser initialization (locating .wasm files in dist/).
   *
   * **IMPORTANT:** This must be provided by the extension host when creating the worker.
   * Without it, WASM parsers (PythonSymbolAnalyzer, RustSymbolAnalyzer) cannot 
   * initialize and symbol extraction for Python/Rust files will fail.
   *
   * Example: context.extensionPath from VS Code extension activation
   *
   * @see Requirements 5.3 - Support Electron Environment
   */
  extensionPath?: string;
}

const data = workerData as WorkerData;
const extensionPath = data.extensionPath ?? process.cwd();

// Worker message types
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

// Initialize analyzers
const log = getLogger('AstWorker');
const symbolAnalyzer = new SymbolAnalyzer(undefined, { maxFiles: 100 });

// Initialize WASM-based symbol analyzers with extensionPath
// The extensionPath is required for Python and Rust analyzers to locate WASM files
// in the extension's dist/ directory (tree-sitter-python.wasm, tree-sitter-rust.wasm)
// If extensionPath is not provided, WASM initialization will fail and symbol extraction
// for Python/Rust files will throw errors (caught in handleMessage)
const pythonSymbolAnalyzer = new PythonSymbolAnalyzer(undefined, extensionPath);
const rustSymbolAnalyzer = new RustSymbolAnalyzer(undefined, extensionPath);
const signatureAnalyzer = new SignatureAnalyzer();

/**
 * Detect language based on file extension
 */
function detectLanguage(filePath: string): 'python' | 'rust' | 'typescript' {
  const language = detectLanguageFromExtension(filePath);
  if (language === 'python') {
    return 'python';
  }
  if (language === 'rust') {
    return 'rust';
  }
  return 'typescript';
}

/**
 * Handle incoming messages from the parent thread
 */
async function handleMessage(message: WorkerRequest): Promise<void> {
  try {
    let result: unknown;

    switch (message.type) {
      case 'analyzeFile': {
        const language = detectLanguage(message.filePath);
        // Use language-specific analyzers for Python and Rust (WASM-based)
        // For TypeScript/JavaScript, use ts-morph-based SymbolAnalyzer
        //
        // **WASM Error Handling:**
        // If WASM initialization fails (e.g., missing .wasm files, LinkError in Node.js),
        // the analyzer will throw an error which is caught by the outer try-catch
        // and returned as an error response to the caller.
        //
        // **Parser Initialization:**
        // WASM parsers must be initialized before calling analyzeFileContent().
        // In test environments where WASM doesn't work, tests should mock the worker
        // or skip Python/Rust analysis tests.
        if (language === 'python') {
          await pythonSymbolAnalyzer.ensureInitialized();
          const { symbols, dependencies } = pythonSymbolAnalyzer.analyzeFileContent(
            message.filePath,
            message.content
          );
          result = { symbols, dependencies };
        } else if (language === 'rust') {
          await rustSymbolAnalyzer.ensureInitialized();
          const { symbols, dependencies } = rustSymbolAnalyzer.analyzeFileContent(
            message.filePath,
            message.content
          );
          result = { symbols, dependencies };
        } else {
          const { symbols, dependencies } = symbolAnalyzer.analyzeFileContent(
            message.filePath,
            message.content
          );
          result = { symbols, dependencies };
        }
        break;
      }

      case 'getInternalExportDeps': {
        const graph = symbolAnalyzer.getInternalExportDependencyGraph(
          message.filePath,
          message.content
        );
        // Convert Map to plain object for serialization
        result = Object.fromEntries(
          Array.from(graph.entries()).map(([k, v]) => [k, Array.from(v)])
        );
        break;
      }

      case 'extractSignatures': {
        result = signatureAnalyzer.extractSignatures(message.filePath, message.content);
        break;
      }

      case 'extractInterfaceMembers': {
        const members = signatureAnalyzer.extractInterfaceMembers(
          message.filePath,
          message.content
        );
        // Convert Map to plain object for serialization
        result = Object.fromEntries(members);
        break;
      }

      case 'extractTypeAliases': {
        result = signatureAnalyzer.extractTypeAliases(message.filePath, message.content);
        break;
      }

      case 'compareSignatures': {
        result = signatureAnalyzer.compareSignatures(message.oldSig, message.newSig);
        break;
      }

      case 'analyzeBreakingChanges': {
        result = signatureAnalyzer.analyzeBreakingChanges(
          message.filePath,
          message.oldContent,
          message.newContent
        );
        break;
      }

      case 'reset': {
        symbolAnalyzer.reset();
        result = { success: true };
        break;
      }

      case 'getFileCount': {
        result = symbolAnalyzer.getFileCount();
        break;
      }

      default: {
        const exhaustive: never = message;
        throw new Error(`Unknown message type: ${JSON.stringify(exhaustive)}`);
      }
    }

    // Send success response
    const response: WorkerResponse = {
      type: 'success',
      id: message.id,
      result,
    };
    parentPort?.postMessage(response);
  } catch (error) {
    // Send error response
    const errorMessage = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    const response: WorkerResponse = {
      type: 'error',
      id: message.id,
      error: errorMessage,
      stack,
    };
    parentPort?.postMessage(response);
  }
}

// Listen for messages from parent thread
if (parentPort) {
  parentPort.on('message', (message: WorkerRequest) => {
    void handleMessage(message);
  });
} else {
  log.error('parentPort is null - worker not properly initialized');
  process.exit(1);
}

// Export types for use in AstWorkerHost
export type {
    InterfaceMemberInfo, SignatureComparisonResult, SignatureInfo, TypeAliasInfo
} from '../SignatureAnalyzer';
export type { SymbolDependency, SymbolInfo } from '../types';
export type { WorkerRequest, WorkerResponse };
