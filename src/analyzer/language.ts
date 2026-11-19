// A leaf module: utilities typed by Language must not import LanguageService, which loads every parser (#774).
/**
 * Language detection based on file extension
 */
export enum Language {
  TypeScript = "typescript",
  Python = "python",
  Rust = "rust",
  CSharp = "csharp",
  Go = "go",
  Java = "java",
  Unknown = "unknown",
}
