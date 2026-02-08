import path from "node:path";
import { Parser } from "./Parser";
import { SymbolAnalyzer } from "./SymbolAnalyzer";
import { PythonParser } from "./languages/PythonParser";
import { PythonSymbolAnalyzer } from "./languages/PythonSymbolAnalyzer";
import { RustParser } from "./languages/RustParser";
import { RustSymbolAnalyzer } from "./languages/RustSymbolAnalyzer";
import { ILanguageAnalyzer, ISymbolAnalyzer } from "./types";
import { extractFilePath } from "./utils/PathExtractor";

/**
 * Language detection based on file extension
 */
export enum Language {
  TypeScript = "typescript",
  Python = "python",
  Rust = "rust",
  Unknown = "unknown",
}

/**
 * Factory service for obtaining language-specific analyzers.
 * Implements lazy-loading to avoid loading parsers for unused languages.
 */
export class LanguageService {
  private static readonly typeScriptParsers = new Map<string, Parser>();
  private static readonly typeScriptSymbolAnalyzers = new Map<string, SymbolAnalyzer>();
  private static readonly pythonParsers = new Map<string, PythonParser>();
  private static readonly pythonSymbolAnalyzers = new Map<string, PythonSymbolAnalyzer>();
  private static readonly rustParsers = new Map<string, RustParser>();
  private static readonly rustSymbolAnalyzers = new Map<string, RustSymbolAnalyzer>();

  private readonly rootDir?: string;
  private readonly extensionPath?: string;

  constructor(rootDir?: string, _tsConfigPath?: string, extensionPath?: string) {
    this.rootDir = rootDir;
    this.extensionPath = extensionPath;
  }

  /**
   * Instance method to get analyzer with instance-specific config
   */
  getAnalyzer(filePath: string): ILanguageAnalyzer {
    const actualPath = extractFilePath(filePath);
    return LanguageService.getAnalyzer(actualPath, this.rootDir, this.extensionPath);
  }

  /**
   * Instance method to get symbol analyzer with instance-specific config
   */
  getSymbolAnalyzer(filePath: string): ISymbolAnalyzer {
    const actualPath = extractFilePath(filePath);
    return LanguageService.getSymbolAnalyzer(actualPath, this.rootDir, this.extensionPath);
  }

  /**
   * Detect the language based on file extension
   */
  static detectLanguage(filePath: string): Language {
    // Extract file path from potential symbol ID
    const actualPath = extractFilePath(filePath);
    const ext = path.extname(actualPath).toLowerCase();

    switch (ext) {
      case ".ts":
      case ".tsx":
      case ".js":
      case ".jsx":
      case ".mjs":
      case ".cjs":
      case ".vue":
      case ".svelte":
      case ".gql":
      case ".graphql":
        return Language.TypeScript;

      case ".py":
      case ".pyi":
        return Language.Python;

      case ".rs":
      case ".toml":
        return Language.Rust;

      default:
        return Language.Unknown;
    }
  }

  /**
   * Get the appropriate parser for the given file path.
   * Lazy-loads parsers only when needed.
   */
  static getAnalyzer(filePath: string, rootDir?: string, extensionPath?: string): ILanguageAnalyzer {
    const actualPath = extractFilePath(filePath);
    const language = this.detectLanguage(actualPath);

    switch (language) {
      case Language.TypeScript: {
        const cacheKey = this.buildCacheKey(rootDir);
        const cached = this.typeScriptParsers.get(cacheKey);
        if (cached) {
          return cached;
        }
        const created = new Parser(rootDir);
        this.typeScriptParsers.set(cacheKey, created);
        return created;
      }

      case Language.Python: {
        const cacheKey = this.buildCacheKey(rootDir, extensionPath);
        const cached = this.pythonParsers.get(cacheKey);
        if (cached) {
          return cached;
        }
        const created = new PythonParser(rootDir, extensionPath);
        this.pythonParsers.set(cacheKey, created);
        return created;
      }

      case Language.Rust: {
        const cacheKey = this.buildCacheKey(rootDir, extensionPath);
        const cached = this.rustParsers.get(cacheKey);
        if (cached) {
          return cached;
        }
        const created = new RustParser(rootDir, extensionPath);
        this.rustParsers.set(cacheKey, created);
        return created;
      }

      default:
        throw new Error(`Unsupported language for file: ${filePath}`);
    }
  }

  /**
   * Get the appropriate symbol analyzer for the given file path.
   * Lazy-loads analyzers only when needed.
   */
  static getSymbolAnalyzer(
    filePath: string,
    rootDir?: string,
    extensionPath?: string,
  ): ISymbolAnalyzer {
    const actualPath = extractFilePath(filePath);
    const language = this.detectLanguage(actualPath);

    switch (language) {
      case Language.TypeScript: {
        const cacheKey = this.buildCacheKey(rootDir);
        const cached = this.typeScriptSymbolAnalyzers.get(cacheKey);
        if (cached) {
          return cached;
        }
        const created = new SymbolAnalyzer(rootDir);
        this.typeScriptSymbolAnalyzers.set(cacheKey, created);
        return created;
      }

      case Language.Python: {
        const cacheKey = this.buildCacheKey(rootDir, extensionPath);
        const cached = this.pythonSymbolAnalyzers.get(cacheKey);
        if (cached) {
          return cached;
        }
        const created = new PythonSymbolAnalyzer(rootDir, extensionPath);
        this.pythonSymbolAnalyzers.set(cacheKey, created);
        return created;
      }

      case Language.Rust: {
        const cacheKey = this.buildCacheKey(rootDir, extensionPath);
        const cached = this.rustSymbolAnalyzers.get(cacheKey);
        if (cached) {
          return cached;
        }
        const created = new RustSymbolAnalyzer(rootDir, extensionPath);
        this.rustSymbolAnalyzers.set(cacheKey, created);
        return created;
      }

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
    this.typeScriptParsers.clear();
    this.typeScriptSymbolAnalyzers.clear();
    this.pythonParsers.clear();
    this.pythonSymbolAnalyzers.clear();
    this.rustParsers.clear();
    this.rustSymbolAnalyzers.clear();
  }

  private static buildCacheKey(...parts: Array<string | undefined>): string {
    return parts.map((part) => part ?? "").join("\u0000");
  }
}
