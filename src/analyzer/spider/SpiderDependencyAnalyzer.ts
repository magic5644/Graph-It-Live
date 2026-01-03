import { LanguageService } from '../LanguageService';
import { PathResolver } from '../utils/PathResolver';
import { Cache } from '../Cache';
import { ReverseIndex } from '../ReverseIndex';
import { ReverseIndexManager } from '../ReverseIndexManager';
import { Dependency, SpiderError, normalizePath } from '../types';
import { getLogger } from '../../shared/logger';

const log = getLogger('SpiderDependencyAnalyzer');

/**
 * Single responsibility: read/parse/resolve a file into resolved dependencies,
 * with caching and reverse-index synchronization.
 */
export class SpiderDependencyAnalyzer {
  constructor(
    private readonly languageService: LanguageService,
    private readonly resolver: PathResolver,
    private readonly dependencyCache: Cache<Dependency[]>,
    private readonly reverseIndexManager: ReverseIndexManager
  ) {}

  async analyze(filePath: string): Promise<Dependency[]> {
    const key = normalizePath(filePath);

    const cached = this.dependencyCache.get(key);
    if (cached) {
      log.debug(`Returning ${cached.length} cached dependencies for ${filePath}`);
      await this.updateReverseIndexIfEnabled(filePath, key, cached);
      return cached;
    }

    log.debug(`Analyzing ${filePath}...`);
    try {
      // Use LanguageService to get the appropriate analyzer for this file
      const analyzer = this.languageService.getAnalyzer(filePath);
      const parsedImports = await analyzer.parseImports(filePath);

      log.debug(`Parsed ${parsedImports.length} imports from ${filePath}`);

      const dependencies: Dependency[] = [];
      const seenResolvedPaths = new Set<string>();

      for (const imp of parsedImports) {
        // Use analyzer's resolvePath method for language-specific resolution
        const resolvedPath = await analyzer.resolvePath(filePath, imp.module);
        if (!resolvedPath) {
          log.debug(`Failed to resolve module "${imp.module}" from ${filePath}`);
          continue;
        }

        const normalizedResolved = normalizePath(resolvedPath);
        if (seenResolvedPaths.has(normalizedResolved)) continue;
        seenResolvedPaths.add(normalizedResolved);

        dependencies.push({
          path: normalizedResolved,
          type: imp.type,
          line: imp.line,
          module: imp.module,
        });
      }

      log.debug(`Resolved ${dependencies.length} dependencies for ${filePath}`);
      this.dependencyCache.set(key, dependencies);
      await this.updateReverseIndexIfEnabled(filePath, key, dependencies);

      return dependencies;
    } catch (error) {
      const spiderError = SpiderError.fromError(error, filePath);
      log.error('Analysis failed:', spiderError.toUserMessage(), spiderError.code);
      throw spiderError;
    }
  }

  async resolveModuleSpecifier(fromFilePath: string, moduleSpecifier: string): Promise<string | null> {
    try {
      return await this.resolver.resolve(fromFilePath, moduleSpecifier);
    } catch {
      return null;
    }
  }

  invalidateDependencyCache(filePath: string): void {
    this.dependencyCache.delete(normalizePath(filePath));
  }

  private async updateReverseIndexIfEnabled(
    diskFilePath: string,
    normalizedFilePath: string,
    dependencies: Dependency[]
  ): Promise<void> {
    if (!this.reverseIndexManager.isEnabled() || dependencies.length === 0) {
      return;
    }

    const fileHash = await ReverseIndex.getFileHashFromDisk(diskFilePath);
    if (fileHash) {
      this.reverseIndexManager.addDependencies(normalizedFilePath, dependencies, fileHash);
    }
  }
}

