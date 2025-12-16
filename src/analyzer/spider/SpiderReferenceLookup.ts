import { FileReader } from '../FileReader';
import { ReferencingFilesFinder } from '../ReferencingFilesFinder';
import { ReverseIndexManager } from '../ReverseIndexManager';
import type { Dependency } from '../types';
import { normalizePath } from '../types';
import { SpiderDependencyAnalyzer } from './SpiderDependencyAnalyzer';

/**
 * Single responsibility: reverse dependency lookup (reverse index if available,
 * otherwise fallback scan).
 */
export class SpiderReferenceLookup {
  private fallbackFinder: ReferencingFilesFinder | null = null;

  constructor(
    private readonly reverseIndexManager: ReverseIndexManager,
    private readonly dependencyAnalyzer: SpiderDependencyAnalyzer,
    private readonly fileReader: FileReader
  ) {}

  setFallbackFinder(finder: ReferencingFilesFinder): void {
    this.fallbackFinder = finder;
  }

  async findReferencingFiles(targetPath: string): Promise<Dependency[]> {
    if (this.reverseIndexManager.hasEntries()) {
      return this.reverseIndexManager.getReferencingFiles(targetPath);
    }
    return this.fallbackFinder ? this.fallbackFinder.findReferencingFilesFallback(targetPath) : [];
  }

  async findReferenceInFile(
    filePath: string,
    targetPath: string,
    targetBasename: string
  ): Promise<Dependency | null> {
    try {
      const content = await this.fileReader.readFile(filePath);
      if (!content.includes(targetBasename)) {
        return null;
      }

      const dependencies = await this.dependencyAnalyzer.analyze(filePath);
      const matchingDep = dependencies.find((dep) => normalizePath(dep.path) === targetPath);

      if (!matchingDep) {
        return null;
      }

      return {
        path: normalizePath(filePath),
        type: matchingDep.type,
        line: matchingDep.line,
        module: matchingDep.module,
      };
    } catch {
      return null;
    }
  }
}

