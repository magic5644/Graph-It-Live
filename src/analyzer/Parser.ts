import { ParsedImport } from './types';

/**
 * Parses import/require/export statements from TypeScript/JavaScript files
 * CRITICAL: NO vscode imports allowed - pure Node.js only
 */
export class Parser {
  // Regex patterns for different import types
  private readonly patterns = {
    // import ... from '...'
    // Simplified pattern: comments are stripped before parsing
    // Matches: import [whitespace] [anything except ; or ' or "] [whitespace] from [whitespace] [quote] [path] [quote]
    importFrom: /import\s+(?:[^;'"]|'[^']*'|"[^"]*")*?\s+from\s+['"]([^'"]+)['"]/g, //NOSONAR
    
    // export ... from '...'
    exportFrom: /export\s+(?:[^;'"]|'[^']*'|"[^"]*")*?\s+from\s+['"]([^'"]+)['"]/g, //NOSONAR
    
    // require('...')
    require: /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    
    // import('...') - dynamic imports
    dynamicImport: /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,

    // GraphQL #import directive (used in .gql/.graphql files)
    // Matches: #import "./fragment.gql" or #import './fragment.graphql'
    graphqlImport: /#import\s+['"]([^'"]+)['"]/g,
  };

  /**
   * Parse all imports from file content
   * @param content File content to parse
   * @param filePath Optional file path to detect Vue/Svelte/GraphQL files
   */
  parse(content: string, filePath?: string): ParsedImport[] {
    // Extract script content for Vue/Svelte files
    if (filePath) {
      if (filePath.endsWith('.vue') || filePath.endsWith('.svelte')) {
        content = this.extractScript(content);
      }
    }

    const imports: ParsedImport[] = [];
    
    // Track processed modules to avoid duplicates
    const seen = new Set<string>();

    // GraphQL files use #import syntax (don't strip comments as # is the import directive)
    const isGraphQL = filePath?.endsWith('.gql') || filePath?.endsWith('.graphql');
    if (isGraphQL) {
      this.extractImports(content, this.patterns.graphqlImport, 'import', imports, seen);
      return imports;
    }

    // Strip comments to simplify parsing and fix bugs with commented imports
    content = this.stripComments(content);

    // Parse import ... from
    this.extractImports(content, this.patterns.importFrom, 'import', imports, seen);
    
    // Parse export ... from
    this.extractImports(content, this.patterns.exportFrom, 'export', imports, seen);
    
    // Parse require()
    this.extractImports(content, this.patterns.require, 'require', imports, seen);
    
    // Parse dynamic import()
    this.extractImports(content, this.patterns.dynamicImport, 'dynamic', imports, seen);

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
    return matches.map(match => match[1]).join('\n');
  }

  /**
   * Strip comments from content while preserving line numbers/indices
   * Replaces comments with spaces
   */
  private stripComments(content: string): string {
    // Match strings OR comments
    // Group 1: Strings (single or double quoted)
    // Group 2: Comments (single line or block)
    const stringPattern = /'[^']*'|"[^"]*"/;
    const commentPattern = /\/\/[^\n]*|\/\*[\s\S]*?\*\//;
    const combinedPattern = new RegExp(`(${stringPattern.source})|(${commentPattern.source})`, 'g');
    return content.replaceAll(combinedPattern, (_, str, comment) => {
      if (str) {
        return str; // Keep strings
      }
      // Replace comment with spaces/newlines to preserve line numbers
      return comment.replaceAll(/[^\n]/g, ' ');
    });
  }

  private extractImports(
    content: string,
    pattern: RegExp,
    type: ParsedImport['type'],
    imports: ParsedImport[],
    seen: Set<string>
  ): void {
    let match: RegExpExecArray | null;
    
    // Reset regex state
    pattern.lastIndex = 0;
    
    while ((match = pattern.exec(content)) !== null) {
      const module = match[1];
      
      // Skip if already processed
      if (seen.has(module)) {
        continue;
      }
      
      seen.add(module);
      
      // Find line number
      const line = this.getLineNumber(content, match.index);
      
      imports.push({
        module,
        type,
        line,
      });
    }
  }

  private getLineNumber(content: string, index: number): number {
    const upToMatch = content.substring(0, index);
    return upToMatch.split('\n').length;
  }
}
