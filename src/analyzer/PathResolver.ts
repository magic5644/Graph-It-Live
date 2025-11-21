import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Resolves module paths to absolute file paths
 * Handles:
 * - Relative imports (./utils, ../components/Button)
 * - TypeScript path aliases (@/, @components/)
 * - Implicit extensions (.ts, .tsx, .js, .jsx)
 * - Index files (/index.ts)
 * 
 * CRITICAL: NO vscode imports allowed - pure Node.js only
 */
export class PathResolver {
  private readonly pathAliases: Map<string, string> = new Map();
  private tsConfigPromise?: Promise<void>;

  private excludeNodeModules: boolean;

  constructor(tsConfigPath?: string, excludeNodeModules: boolean = true) {
    this.excludeNodeModules = excludeNodeModules;
    if (tsConfigPath) {
      this.tsConfigPromise = this.loadTsConfig(tsConfigPath);
    }
  }

  /**
   * Update configuration
   */
  updateConfig(excludeNodeModules: boolean) {
    this.excludeNodeModules = excludeNodeModules;
  }

  /**
   * Ensure tsConfig is loaded before resolving
   */
  private async ensureTsConfigLoaded(): Promise<void> {
    if (this.tsConfigPromise) {
      await this.tsConfigPromise;
      this.tsConfigPromise = undefined; // Only load once
    }
  }

  /**
   * Load path aliases from tsconfig.json
   */
  private async loadTsConfig(tsConfigPath: string): Promise<void> {
    try {
      const content = await fs.readFile(tsConfigPath, 'utf-8');
      const tsConfig = JSON.parse(content);
      
      const paths = tsConfig?.compilerOptions?.paths;
      const baseUrl = tsConfig?.compilerOptions?.baseUrl || '.';
      
      if (paths) {
        for (const [alias, targets] of Object.entries(paths)) {
          // Remove trailing /* from alias
          const cleanAlias = alias.replace(/\/\*$/, '');
          
          // Get first target and remove trailing /*
          const target = (targets as string[])[0]?.replace(/\/\*$/, '');
          
          if (target) {
            // Resolve relative to tsconfig directory
            const tsConfigDir = path.dirname(tsConfigPath);
            const absoluteTarget = path.resolve(tsConfigDir, baseUrl, target);
            this.pathAliases.set(cleanAlias, absoluteTarget);
          }
        }
      }
    } catch {
      // Gracefully handle missing or invalid tsconfig
      // Silent failure - tsconfig is optional
      // eslint-disable-next-line no-console
    }
  }

  /**
   * Resolve a module path to an absolute file path
   */
  async resolve(currentFilePath: string, modulePath: string): Promise<string | null> {
    // Ensure tsconfig is loaded
    await this.ensureTsConfigLoaded();
    
    // Check if it's a path alias
    const aliasResolved = this.resolveAlias(modulePath);
    if (aliasResolved) {
      return this.resolveWithExtensions(aliasResolved);
    }

    // Handle node_modules
    if (this.isNodeModule(modulePath)) {
      if (this.excludeNodeModules) {
        return null;
      }
      // Return the module name itself (e.g. "react")
      // We might want to resolve to the package.json or main file, but for visualization,
      // just the package name is often enough and cleaner.
      // However, to be a valid "path" for the graph, it should be unique.
      // Let's return the module name prefixed to indicate it's a module?
      // Or just the module name. The graph uses IDs.
      return modulePath;
    }

    // Resolve relative paths
    if (this.isRelativePath(modulePath)) {
      const currentDir = path.dirname(currentFilePath);
      const absolutePath = path.resolve(currentDir, modulePath);
      return this.resolveWithExtensions(absolutePath);
    }

    return null;
  }

  /**
   * Resolve path aliases
   */
  private resolveAlias(modulePath: string): string | null {
    for (const [alias, target] of this.pathAliases.entries()) {
      if (modulePath === alias || modulePath.startsWith(alias + '/')) {
        // Replace alias with target path
        const resolved = modulePath.replace(alias, target);
        return resolved;
      }
    }
    return null;
  }

  /**
   * Try different file extensions
   */
  private async resolveWithExtensions(basePath: string): Promise<string | null> {
    const extensions = ['.ts', '.tsx', '.js', '.jsx', '.vue', '.svelte', '.mjs', '.cjs'];
    
    // Try exact path first
    if (await this.fileExists(basePath)) {
      return basePath;
    }

    // Try with extensions
    for (const ext of extensions) {
      const pathWithExt = basePath + ext;
      if (await this.fileExists(pathWithExt)) {
        return pathWithExt;
      }
    }

    // Try index files
    for (const ext of extensions) {
      const indexPath = path.join(basePath, `index${ext}`);
      if (await this.fileExists(indexPath)) {
        return indexPath;
      }
    }

    return null;
  }

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      const stats = await fs.stat(filePath);
      return stats.isFile();
    } catch {
      return false;
    }
  }

  private isRelativePath(modulePath: string): boolean {
    return modulePath.startsWith('./') || modulePath.startsWith('../');
  }

  private isNodeModule(modulePath: string): boolean {
    // Node modules don't start with . or /
    return !modulePath.startsWith('.') && !modulePath.startsWith('/');
  }
}
