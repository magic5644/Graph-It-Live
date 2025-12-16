import { Parser } from '../Parser';
import { PathResolver } from '../PathResolver';
import { Cache } from '../Cache';
import { ReverseIndex } from '../ReverseIndex';
import { ReverseIndexManager } from '../ReverseIndexManager';
import { FileReader } from '../FileReader';
import { Dependency, SpiderError, normalizePath } from '../types';
import { getLogger } from '../../shared/logger';

const log = getLogger('SpiderDependencyAnalyzer');

/**
 * Single responsibility: read/parse/resolve a file into resolved dependencies,
 * with caching and reverse-index synchronization.
 */
export class SpiderDependencyAnalyzer {
  constructor(
    private readonly parser: Parser,
    private readonly resolver: PathResolver,
    private readonly fileReader: FileReader,
    private readonly dependencyCache: Cache<Dependency[]>,
    private readonly reverseIndexManager: ReverseIndexManager
  ) {}

  async analyze(filePath: string): Promise<Dependency[]> {
    const key = normalizePath(filePath);

    const cached = this.dependencyCache.get(key);
    if (cached) {
      await this.updateReverseIndexIfEnabled(filePath, key, cached);
      return cached;
    }

    try {
      const content = await this.fileReader.readFile(filePath);
      const parsedImports = this.parser.parse(content, filePath);

      const dependencies: Dependency[] = [];
      const seenResolvedPaths = new Set<string>();

      for (const imp of parsedImports) {
        const resolvedPath = await this.resolver.resolve(filePath, imp.module);
        if (!resolvedPath) continue;

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

