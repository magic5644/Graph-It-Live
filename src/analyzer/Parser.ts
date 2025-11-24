import { ParsedImport } from './types';

/**
 * Parses import/require/export statements from TypeScript/JavaScript files
 * CRITICAL: NO vscode imports allowed - pure Node.js only
 */
export class Parser {
  // Regex patterns for different import types
  private readonly patterns = {
    // import ... from '...'
    // simplified: match "import" followed by anything up to the "from" keyword
    // then capture the module string — this reduces regex complexity while
    // still catching normal import-from declarations.
    importFrom: /import\s+[^;]*?from\s+['"]([^'"]+)['"]/g,
    
    // export ... from '...'
    // simplified: match "export" followed by anything up to "from"
    // then capture the module string
    exportFrom: /export\s+[^;]*?from\s+['"]([^'"]+)['"]/g,
    
    // require('...')
    require: /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    
    // import('...') - dynamic imports
    dynamicImport: /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  };

  /**
   * Parse all imports from file content
   * @param content File content to parse
   * @param filePath Optional file path to detect Vue/Svelte files
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
    const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script\s*[^>]*>/gi;
    const matches = [...content.matchAll(scriptRegex)];
    
    // Join all script contents with a newline to ensure separation
    return matches.map(match => match[1]).join('\n');
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
