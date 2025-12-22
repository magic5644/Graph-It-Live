/**
 * AST Worker Thread - Isolates ts-morph from main extension bundle
 * 
 * This worker runs in a separate thread to avoid bundling ts-morph (12MB+) 
 * in extension.js and mcpWorker.js. All AST-based analysis (SymbolAnalyzer, 
 * SignatureAnalyzer) is delegated here.
 * 
 * CRITICAL: This module is completely VS Code agnostic!
 * NO import * as vscode from 'vscode' allowed!
 */

import { parentPort } from 'node:worker_threads';
import { SymbolAnalyzer } from './SymbolAnalyzer';
import { SignatureAnalyzer } from './SignatureAnalyzer';
import type { SignatureInfo } from './SignatureAnalyzer';

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
const symbolAnalyzer = new SymbolAnalyzer({ maxFiles: 100 });
const signatureAnalyzer = new SignatureAnalyzer();

/**
 * Handle incoming messages from the parent thread
 */
function handleMessage(message: WorkerRequest): void {
  try {
    let result: unknown;

    switch (message.type) {
      case 'analyzeFile': {
        const { symbols, dependencies } = symbolAnalyzer.analyzeFile(
          message.filePath,
          message.content
        );
        result = { symbols, dependencies };
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
  parentPort.on('message', handleMessage);
} else {
  console.error('AstWorker: parentPort is null - worker not properly initialized');
  process.exit(1);
}

// Export types for use in AstWorkerHost
export type { WorkerRequest, WorkerResponse };
export type { SymbolInfo, SymbolDependency } from './types';
export type {
  SignatureInfo,
  InterfaceMemberInfo,
  TypeAliasInfo,
  SignatureComparisonResult,
} from './SignatureAnalyzer';
