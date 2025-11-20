import * as fs from 'node:fs/promises';
import { Parser } from './Parser';
import { PathResolver } from './PathResolver';
import { Cache } from './Cache';
import { Dependency, SpiderConfig } from './types';

/**
 * Main analyzer class - "The Spider"
 * Crawls through files to extract and resolve dependencies
 * 
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 * NO import * as vscode from 'vscode' allowed!
 * Only Node.js built-in modules (fs, path) are permitted.
 */
export class Spider {
  private readonly parser: Parser;
  private readonly resolver: PathResolver;
  private readonly cache: Cache<Dependency[]>;
  private readonly config: SpiderConfig;

  constructor(config: SpiderConfig) {
    this.config = {
      maxDepth: 3,
      excludeNodeModules: true,
      ...config,
    };
    
    this.parser = new Parser();
    this.resolver = new PathResolver(
      config.tsConfigPath,
      this.config.excludeNodeModules
    );
    this.cache = new Cache();
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<SpiderConfig>) {
    this.config.excludeNodeModules = config.excludeNodeModules ?? this.config.excludeNodeModules;
    this.config.maxDepth = config.maxDepth ?? this.config.maxDepth;
    
    if (config.excludeNodeModules !== undefined) {
      this.resolver.updateConfig(config.excludeNodeModules);
    }
    
    // Clear cache as config changed
    this.clearCache();
  }

  /**
   * Analyze a file and return its dependencies
   * @param filePath Absolute path to the file to analyze
   * @returns Array of dependencies
   */
  async analyze(filePath: string): Promise<Dependency[]> {
    // Check cache first
    const cached = this.cache.get(filePath);
    if (cached) {
      return cached;
    }

    try {
      // Read file content
      const content = await fs.readFile(filePath, 'utf-8');

      // Parse imports
      const parsedImports = this.parser.parse(content);

      // Resolve paths
      const dependencies: Dependency[] = [];
      
      for (const imp of parsedImports) {
        const resolvedPath = await this.resolver.resolve(filePath, imp.module);
        
        if (resolvedPath) {
          dependencies.push({
            path: resolvedPath,
            type: imp.type,
            line: imp.line,
            module: imp.module,
          });
        }
      }

      // Cache results
      this.cache.set(filePath, dependencies);

      return dependencies;
    } catch (error) {
      // Re-throw with more context
      if (error instanceof Error) {
        throw new Error(`Failed to analyze ${filePath}: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * Clear the cache
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { size: number } {
    return {
      size: this.cache.size,
    };
  }
}
