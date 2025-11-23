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
      const parsedImports = this.parser.parse(content, filePath);

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
   * Crawl the dependency graph starting from an entry file
   * @param entryFile Absolute path to the entry file
   * @returns Graph data (nodes and edges)
   */
  async crawl(startPath: string): Promise<{ nodes: string[]; edges: { source: string; target: string }[] }> {
    const nodes = new Set<string>();
    const edges: { source: string; target: string }[] = [];
    const visited = new Set<string>();

    const startTime = Date.now();

    const crawlRecursive = async (filePath: string, depth: number) => {
      // Stop if max depth reached
      if (depth > this.config.maxDepth) {
        console.log(`[Spider] Max depth ${this.config.maxDepth} reached at ${filePath}`);
        return;
      }

      // Skip if already visited
      if (visited.has(filePath)) {
        return;
      }

      visited.add(filePath);
      nodes.add(filePath);

      console.log(`[Spider] Crawling ${filePath.split('/').pop()} at depth ${depth}/${this.config.maxDepth}`);

      try {
        const dependencies = await this.analyze(filePath);

        for (const dep of dependencies) {
          nodes.add(dep.path);
          edges.push({
            source: filePath,
            target: dep.path,
          });

          // Recurse if not in node_modules
          if (!dep.path.includes('node_modules')) {
            await crawlRecursive(dep.path, depth + 1);
          }
        }
      } catch (error) {
        console.error(`[Spider] Failed to analyze ${filePath}:`, error instanceof Error ? error.message : error);
      }
    };

    await crawlRecursive(startPath, 0);

    const duration = Date.now() - startTime;
    console.log(`[Spider] Crawled ${nodes.size} nodes and ${edges.length} edges in ${duration}ms (maxDepth=${this.config.maxDepth})`);

    return {
      nodes: Array.from(nodes),
      edges,
    };
  }

  /**
   * Crawl from a specific node to discover new dependencies (on-demand scan)
   * @param startNode Node to start scanning from
   * @param existingNodes Nodes already known (to avoid re-scanning)
   * @param extraDepth Additional depth to scan from this node
   * @returns New graph data discovered (only new nodes and edges)
   */
  async crawlFrom(
    startNode: string, 
    existingNodes: Set<string>, 
    extraDepth: number = 10
  ): Promise<{ nodes: string[]; edges: { source: string; target: string }[] }> {
    const newNodes = new Set<string>();
    const newEdges: { source: string; target: string }[] = [];
    const visited = new Set<string>(existingNodes); // Don't revisit known nodes

    const crawlRecursive = async (filePath: string, depth: number) => {
      if (depth > extraDepth) {
        return;
      }
      if (visited.has(filePath) && filePath !== startNode) {
        // Skip already visited nodes, EXCEPT the start node itself
        return;
      }

      visited.add(filePath);
      
      // Only add to newNodes if it wasn't in existingNodes
      if (!existingNodes.has(filePath)) {
        newNodes.add(filePath);
      }

      try {
        const dependencies = await this.analyze(filePath);

        for (const dep of dependencies) {
          const edge = { source: filePath, target: dep.path };
          
          // Only add edge if it's truly new
          newEdges.push(edge);
          
          if (!visited.has(dep.path)) {
            newNodes.add(dep.path);
          }

          // Recurse if not in node_modules
          if (!dep.path.includes('node_modules')) {
            await crawlRecursive(dep.path, depth + 1);
          }
        }
      } catch (error) {
        console.error(`Failed to crawl from ${filePath}:`, error);
      }
    };

    await crawlRecursive(startNode, 0);

    console.log(`[Spider.crawlFrom] Found ${newNodes.size} new nodes and ${newEdges.length} new edges from ${startNode}`);

    return {
      nodes: Array.from(newNodes),
      edges: newEdges,
    };
  }



  /**
   * Find files that reference the given file (reverse dependency lookup)
   * @param targetPath Absolute path to the file to find references for
   * @returns Array of dependencies pointing to the target file
   */
  async findReferencingFiles(targetPath: string): Promise<Dependency[]> {
    const referencingFiles: Dependency[] = [];
    const targetBasename = targetPath.split(/[/\\]/).pop()?.replace(/\.[^/.]+$/, ''); // filename without extension
    
    if (!targetBasename) {
      return [];
    }

    console.log(`[Spider] Finding references for ${targetPath} (basename: ${targetBasename})`);

    // Helper to recursively walk directory
    const walk = async (dir: string) => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = `${dir}/${entry.name}`; // Simple path join
        
        if (entry.isDirectory()) {
          // Skip node_modules if configured
          if (this.config.excludeNodeModules && entry.name === 'node_modules') {
            continue;
          }
          // Skip .git and other hidden dirs
          if (entry.name.startsWith('.')) {
            continue;
          }
          await walk(fullPath);
        } else if (entry.isFile()) {
          // Only check supported files
          if (!/\.(ts|tsx|js|jsx|vue|svelte)$/.test(entry.name)) {
            continue;
          }
          
          // Skip the target file itself
          if (fullPath === targetPath) {
            continue;
          }

          try {
            // Optimization: Quick check if file content contains the target basename
            const content = await fs.readFile(fullPath, 'utf-8');
            if (!content.includes(targetBasename)) {
              continue;
            }

            // Parse imports
            const dependencies = await this.analyze(fullPath);
            
            // Check if any dependency resolves to targetPath
            for (const dep of dependencies) {
              if (dep.path === targetPath) {
                console.log(`[Spider] Found reference in ${fullPath}`);
                referencingFiles.push({
                  path: fullPath, // The file DOING the importing
                  type: dep.type,
                  line: dep.line,
                  module: dep.module
                });
                break; // Found a reference, no need to check other imports in this file
              }
            }
          } catch (error) {
            console.error(`[Spider] Error checking references in ${fullPath}:`, error);
          }
        }
      }
    };

    await walk(this.config.rootDir);
    return referencingFiles;
  }

  /**
   * Get cache statistics
   * @returns Cache statistics
   */
  getCacheStats(): { size: number } {
    return {
      size: this.cache.size,
    };
  }
}
