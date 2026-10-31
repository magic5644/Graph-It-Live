import { FileReader } from "./FileReader";
import type { Dependency, ILanguageAnalyzer, ImportResolution, ParsedImport } from "./types";
import { maskNonCode } from "./utils/maskNonCode";
import { extractFilePath } from "./utils/PathExtractor";
import { PathResolver } from "./utils/PathResolver";

/**
 * Parses import/require/export statements from TypeScript/JavaScript files
 * CRITICAL: NO vscode imports allowed - pure Node.js only
 */
export class Parser implements ILanguageAnalyzer {
  private readonly fileReader: FileReader;
  private readonly pathResolver: PathResolver;

  private readonly ignoreTypeImports: boolean;
  constructor(rootDir?: string, ignoreTypeImports?: boolean) {
    this.fileReader = new FileReader();
    // rootDir is the workspace root, not a tsconfig path: aliases come from the nearest tsconfig.json.
    this.pathResolver = new PathResolver(undefined, true, rootDir);
    this.ignoreTypeImports = ignoreTypeImports ?? false;
  }
  // Regex patterns for different import types
  private readonly patterns = {
    // import ... from '...'
    // Simplified pattern: comments are stripped before parsing
    // Matches: import [whitespace] [anything except ; or ' or "] [whitespace] from [whitespace] [quote] [path] [quote]
    importFrom:
      /import\s+(?:[^;'"]|'[^']*'|"[^"]*")*?\s+from\s+['"]([^'"]+)['"]/dg, //NOSONAR

    // export ... from '...'
    exportFrom:
      /export\s+(?:[^;'"]|'[^']*'|"[^"]*")*?\s+from\s+['"]([^'"]+)['"]/dg, //NOSONAR

    // require('...')
    require: /require\s*\(\s*['"]([^'"]+)['"]\s*\)/dg,

    // import('...') - dynamic imports
    dynamicImport: /import\s*\(\s*['"]([^'"]+)['"]\s*\)/dg,

    // import '...' - side-effect import, no binding. Only at a line start, so
    // `export {}; import './x'` on one line is missed (shortcut: upgrade with a real tokenizer).
    sideEffectImport: /^[ \t]*import\s*['"]([^'"]+)['"]/dgm,

    // GraphQL #import directive (used in .gql/.graphql files)
    // Matches: #import "./fragment.gql" or #import './fragment.graphql'
    graphqlImport: /#import\s+['"]([^'"]+)['"]/dg,
  };

  /**
   * Parse all imports from file content
   * @param content File content to parse
   * @param filePath Optional file path to detect Vue/Svelte/GraphQL files
   */
  parse(content: string, filePath?: string): ParsedImport[] {
    // Extract script content for Vue/Svelte files
    if (filePath) {
      if (filePath.endsWith(".vue") || filePath.endsWith(".svelte")) {
        content = this.extractScript(content);
      }
    }

    const imports: ParsedImport[] = [];

    // Track processed modules to avoid duplicates
    const seen = new Set<string>();

    // GraphQL files use #import syntax (don't strip comments as # is the import directive)
    const isGraphQL =
      filePath?.endsWith(".gql") || filePath?.endsWith(".graphql");
    if (isGraphQL) {
      this.extractImports(
        { scan: content, source: content },
        this.patterns.graphqlImport,
        "import",
        imports,
        seen,
      );
      return imports;
    }

    // Patterns run on code only: comments and the text of strings and templates are masked,
    // so `"import a from './a'"` in a string or a commented import is not read as an import.
    const text = { scan: maskNonCode(content), source: content };

    // Parse import ... from
    this.extractImports(
      text,
      this.patterns.importFrom,
      "import",
      imports,
      seen,
    );

    // Parse export ... from
    this.extractImports(
      text,
      this.patterns.exportFrom,
      "export",
      imports,
      seen,
    );

    // Parse require()
    this.extractImports(
      text,
      this.patterns.require,
      "require",
      imports,
      seen,
    );

    // Parse dynamic import()
    this.extractImports(
      text,
      this.patterns.dynamicImport,
      "dynamic",
      imports,
      seen,
    );

    // Parse bare import: own dedupe set, so `import './x'` next to `import {a} from './x'` stays visible;
    // the dependency resolver keeps the first (symbol-carrying) entry per target.
    this.extractImports(
      text,
      this.patterns.sideEffectImport,
      "side-effect",
      imports,
      new Set<string>(),
    );

    return imports;
  }

  /**
   * Extract script content from Vue/Svelte files
   */
  private extractScript(content: string): string {
    // Match <script> or <script setup> or <script lang="ts"> etc.
    // Use global flag 'g' and matchAll to get all script blocks
    const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script\s*[^>]*>/gi; //NOSONAR
    const matches = [...content.matchAll(scriptRegex)];

    // Join all script contents with a newline to ensure separation
    return matches.map((match) => match[1]).join("\n");
  }

  private extractImports(
    text: { scan: string; source: string },
    pattern: RegExp,
    type: ParsedImport["type"],
    imports: ParsedImport[],
    seen: Set<string>,
  ): void {
    let match: RegExpExecArray | null;

    // Reset regex state
    pattern.lastIndex = 0;

    while ((match = pattern.exec(text.scan)) !== null) {
      // Patterns carry the `d` flag: the specifier is read back from the unmasked source.
      const [start, end] = match.indices?.[1] ?? [0, 0];
      const module = text.source.slice(start, end);

      // Skip if already processed
      if (seen.has(module)) {
        continue;
      }

      // Skip type-only imports if configured to ignore them
      if (this.ignoreTypeImports && Parser.isTypeOnlyImport(match[0].trim())) {
        continue;
      }

      seen.add(module);

      // Find line number
      const line = this.getLineNumber(text.scan, match.index);

      imports.push({
        module,
        type,
        line,
      });
    }
  }

  /** `import type ...`, or TS 5+ named imports/exports whose specifiers are all `type`. */
  private static isTypeOnlyImport(fullMatch: string): boolean {
    // `import type ...` / `export type ...`
    if (/^(import|export)\s+type\b/.test(fullMatch)) {
      return true;
    }

    // TS 5+ type-only named imports/exports: `import { type Foo } from '...'`
    const braceMatch = /^(import|export)\s+\{([\s\S]*?)\}\s+from\b/.exec(fullMatch);
    if (!braceMatch) {
      return false;
    }
    const specifiers = braceMatch[2]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return specifiers.length > 0 && specifiers.every((s) => /^type\b/.test(s));
  }

  private getLineNumber(content: string, index: number): number {
    const upToMatch = content.substring(0, index);
    return upToMatch.split("\n").length;
  }

  /**
   * ILanguageAnalyzer implementation: Parse imports from a file
   */
  async parseImports(filePath: string): Promise<Dependency[]> {
    // Extract file path from potential symbol ID
    const actualPath = extractFilePath(filePath);
    const content = await this.fileReader.readFile(actualPath);
    const parsed = this.parse(content, actualPath);

    return parsed.map((p) => ({
      path: "", // Will be resolved separately via resolvePath()
      type: p.type,
      line: p.line,
      module: p.module,
    }));
  }

  /**
   * ILanguageAnalyzer implementation: Resolve module path
   */
  resolvePath(
    fromFile: string,
    moduleSpecifier: string,
  ): Promise<string | null> {
    // Extract file path from potential symbol ID
    const actualFromFile = extractFilePath(fromFile);
    return this.pathResolver.resolve(actualFromFile, moduleSpecifier);
  }

  /**
   * ILanguageAnalyzer implementation: Resolve module path, reporting a target
   * outside the workspace root
   */
  resolveImport(
    fromFile: string,
    moduleSpecifier: string,
  ): Promise<ImportResolution> {
    return this.pathResolver.resolveImport(extractFilePath(fromFile), moduleSpecifier);
  }
}
