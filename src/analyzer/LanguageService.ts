import path from 'node:path';
import { ILanguageAnalyzer, ISymbolAnalyzer } from './types';
import { Parser } from './Parser';
import { SymbolAnalyzer } from './SymbolAnalyzer';
import { PythonParser } from './languages/PythonParser';
import { PythonSymbolAnalyzer } from './languages/PythonSymbolAnalyzer';

/**
 * Language detection based on file extension
 */
export enum Language {
  TypeScript = 'typescript',
  Python = 'python',
  Rust = 'rust',
  Unknown = 'unknown',
}

/**
 * Factory service for obtaining language-specific analyzers.
 * Implements lazy-loading to avoid loading parsers for unused languages.
 */
export class LanguageService {
  private static typeScriptParser: Parser | null = null;
  private static typeScriptSymbolAnalyzer: SymbolAnalyzer | null = null;
  private static pythonParser: PythonParser | null = null;
  private static pythonSymbolAnalyzer: PythonSymbolAnalyzer | null = null;
  // Rust analyzers will be added in Phase 5 and Phase 6

  private readonly rootDir?: string;
  private readonly tsConfigPath?: string;

  constructor(rootDir?: string, tsConfigPath?: string) {
    this.rootDir = rootDir;
    this.tsConfigPath = tsConfigPath;
  }

  /**
   * Instance method to get analyzer with instance-specific config
   */
  getAnalyzer(filePath: string): ILanguageAnalyzer {
    return LanguageService.getAnalyzer(filePath, this.rootDir);
  }

  /**
   * Instance method to get symbol analyzer with instance-specific config
   */
  getSymbolAnalyzer(filePath: string): ISymbolAnalyzer {
    return LanguageService.getSymbolAnalyzer(filePath, this.rootDir);
  }

  /**
   * Detect the language based on file extension
   */
  static detectLanguage(filePath: string): Language {
    const ext = path.extname(filePath).toLowerCase();
    
    switch (ext) {
      case '.ts':
      case '.tsx':
      case '.js':
      case '.jsx':
      case '.mjs':
      case '.cjs':
      case '.vue':
      case '.svelte':
      case '.gql':
      case '.graphql':
        return Language.TypeScript;
      
      case '.py':
      case '.pyi':
        return Language.Python;
      
      case '.rs':
      case '.toml':
        return Language.Rust;
      
      default:
        return Language.Unknown;
    }
  }

  /**
   * Get the appropriate parser for the given file path.
   * Lazy-loads parsers only when needed.
   */
  static getAnalyzer(filePath: string, rootDir?: string): ILanguageAnalyzer {
    const language = this.detectLanguage(filePath);

    switch (language) {
      case Language.TypeScript:
        if (!this.typeScriptParser) {
          this.typeScriptParser = new Parser(rootDir);
        }
        return this.typeScriptParser;

      case Language.Python:
        if (!this.pythonParser) {
          this.pythonParser = new PythonParser(rootDir);
        }
        return this.pythonParser;

      case Language.Rust:
        // Will be implemented in Phase 5 (TASK-054 to TASK-062)
        throw new Error(`Rust parser not yet implemented`);

      default:
        throw new Error(`Unsupported language for file: ${filePath}`);
    }
  }

  /**
   * Get the appropriate symbol analyzer for the given file path.
   * Lazy-loads analyzers only when needed.
   */
  static getSymbolAnalyzer(filePath: string, rootDir?: string): ISymbolAnalyzer {
    const language = this.detectLanguage(filePath);

    switch (language) {
      case Language.TypeScript:
        if (!this.typeScriptSymbolAnalyzer) {
          this.typeScriptSymbolAnalyzer = new SymbolAnalyzer(rootDir);
        }
        return this.typeScriptSymbolAnalyzer;

      case Language.Python:
        if (!this.pythonSymbolAnalyzer) {
          this.pythonSymbolAnalyzer = new PythonSymbolAnalyzer(rootDir);
        }
        return this.pythonSymbolAnalyzer;

      case Language.Rust:
        // Will be implemented in Phase 6 (TASK-069 to TASK-077)
        throw new Error(`Rust symbol analyzer not yet implemented`);

      default:
        throw new Error(`Unsupported language for file: ${filePath}`);
    }
  }

  /**
   * Check if a file extension is supported
   */
  static isSupported(filePath: string): boolean {
    return this.detectLanguage(filePath) !== Language.Unknown;
  }

  /**
   * Reset all cached analyzers (useful for testing)
   */
  static reset(): void {
    this.typeScriptParser = null;
    this.typeScriptSymbolAnalyzer = null;
    this.pythonParser = null;
    this.pythonSymbolAnalyzer = null;
  }
}
