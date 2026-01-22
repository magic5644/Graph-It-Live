import path from "node:path";
import { getLogger } from "../shared/logger";
import { Parser } from "./Parser";
import { SymbolAnalyzer } from "./SymbolAnalyzer";
import { PythonParser } from "./languages/PythonParser";
import { PythonSymbolAnalyzer } from "./languages/PythonSymbolAnalyzer";
import { RustParser } from "./languages/RustParser";
import { RustSymbolAnalyzer } from "./languages/RustSymbolAnalyzer";
import { ILanguageAnalyzer, ISymbolAnalyzer } from "./types";

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
  private static typeScriptParser: Parser | null = null;
  private static typeScriptSymbolAnalyzer: SymbolAnalyzer | null = null;
  private static pythonParser: PythonParser | null = null;
  private static pythonSymbolAnalyzer: PythonSymbolAnalyzer | null = null;
  private static rustParser: RustParser | null = null;
  private static rustSymbolAnalyzer: RustSymbolAnalyzer | null = null;

  private readonly rootDir?: string;

  constructor(rootDir?: string, _tsConfigPath?: string) {
    this.rootDir = rootDir;
  }

  /**
   * Instance method to get analyzer with instance-specific config
   */
  getAnalyzer(filePath: string): ILanguageAnalyzer {
    const actualPath = LanguageService["extractFilePath"](filePath);
    return LanguageService.getAnalyzer(actualPath, this.rootDir);
  }

  /**
   * Instance method to get symbol analyzer with instance-specific config
   */
  getSymbolAnalyzer(filePath: string): ISymbolAnalyzer {
    const actualPath = LanguageService["extractFilePath"](filePath);
    return LanguageService.getSymbolAnalyzer(actualPath, this.rootDir);
  }

  /**
   * Extract file path from a potential symbol ID (format: "filePath:symbolName")
   * Returns the original path if no colon is found
   */
  private static extractFilePath(pathOrSymbolId: string): string {
    // Symbol IDs have format "filePath:symbolName"
    // File paths should not have colons except for Windows drive letters (e.g., C:\path)
    // If we detect a colon after a file extension, it's likely a symbol ID
    const colonIndex = pathOrSymbolId.lastIndexOf(":");

    if (colonIndex === -1) {
      return pathOrSymbolId;
    }

    // Check if colon is part of Windows drive letter (position 1)
    if (colonIndex === 1 && /^[a-zA-Z]:/.test(pathOrSymbolId)) {
      return pathOrSymbolId;
    }

    // Check if there's a file extension before the colon (e.g., "file.ts:symbolName")
    const beforeColon = pathOrSymbolId.substring(0, colonIndex);
    if (
      /\.(ts|tsx|js|jsx|mjs|cjs|py|rs|vue|svelte|gql|graphql)$/i.test(
        beforeColon,
      )
    ) {
      // This is a symbol ID - extract the file path part
      getLogger("LanguageService").warn(
        `Symbol ID detected where file path expected: ${pathOrSymbolId}. ` +
          `Extracting file path: ${beforeColon}`,
      );
      return beforeColon;
    }

    // Not a symbol ID - return as is
    return pathOrSymbolId;
  }

  /**
   * Detect the language based on file extension
   */
  static detectLanguage(filePath: string): Language {
    // Extract file path from potential symbol ID
    const actualPath = this.extractFilePath(filePath);
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
  static getAnalyzer(filePath: string, rootDir?: string): ILanguageAnalyzer {
    const actualPath = this.extractFilePath(filePath);
    const language = this.detectLanguage(actualPath);

    switch (language) {
      case Language.TypeScript:
        this.typeScriptParser ??= new Parser(rootDir);
        return this.typeScriptParser;

      case Language.Python:
        this.pythonParser ??= new PythonParser(rootDir);
        return this.pythonParser;

      case Language.Rust:
        this.rustParser ??= new RustParser(rootDir);
        return this.rustParser;

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
  ): ISymbolAnalyzer {
    const actualPath = this.extractFilePath(filePath);
    const language = this.detectLanguage(actualPath);

    switch (language) {
      case Language.TypeScript:
        this.typeScriptSymbolAnalyzer ??= new SymbolAnalyzer(rootDir);
        return this.typeScriptSymbolAnalyzer;

      case Language.Python:
        this.pythonSymbolAnalyzer ??= new PythonSymbolAnalyzer(rootDir);
        return this.pythonSymbolAnalyzer;

      case Language.Rust:
        this.rustSymbolAnalyzer ??= new RustSymbolAnalyzer(rootDir);
        return this.rustSymbolAnalyzer;

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
    this.rustParser = null;
    this.rustSymbolAnalyzer = null;
  }
}
