import { SourceFileCollector } from './SourceFileCollector';
import { mapWithConcurrency } from '../shared/concurrency';
import { getLogger } from '../shared/logger';
import { Dependency, normalizePath } from './types';

const log = getLogger('ReferencingFilesFinder');

interface ReferencingFilesFinderOptions {
  sourceFileCollector: SourceFileCollector;
  getRootDir: () => string;
  getConcurrency: () => number | undefined;
  /** The references of `filePath` to each target, read and analyzed once whatever the number of targets. */
  findReferencesInFile: (
    filePath: string,
    targets: ReadonlyArray<FallbackTarget>
  ) => Promise<FallbackReference[]>;
}

/** A target of the fallback scan: its normalized path and the basename a referencing file must contain. */
export interface FallbackTarget {
  path: string;
  basename: string;
}

/** A file referencing the target `target`. */
export interface FallbackReference {
  target: string;
  dependency: Dependency;
}

/**
 * Fallback reverse-reference finder used when the reverse index is unavailable.
 */
export class ReferencingFilesFinder {
  private readonly sourceFileCollector: SourceFileCollector;
  private readonly getRootDir: () => string;
  private readonly getConcurrency: () => number | undefined;
  private readonly findReferencesInFile: ReferencingFilesFinderOptions['findReferencesInFile'];

  constructor(options: ReferencingFilesFinderOptions) {
    this.sourceFileCollector = options.sourceFileCollector;
    this.getRootDir = options.getRootDir;
    this.getConcurrency = options.getConcurrency;
    this.findReferencesInFile = options.findReferencesInFile;
  }

  async findReferencingFilesFallback(targetPath: string): Promise<Dependency[]> {
    return (await this.findReferencingFilesFallbackMany([targetPath])).get(normalizePath(targetPath)) ?? [];
  }

  /**
   * The referencing files of every target, by normalized target path, from one project scan:
   * each file is read and analyzed at most once, not once per target (#605).
   */
  async findReferencingFilesFallbackMany(targetPaths: readonly string[]): Promise<Map<string, Dependency[]>> {
    const keys = [...new Set(targetPaths.map(targetPath => normalizePath(targetPath)))];
    const targets = keys.flatMap(path => {
      const basename = this.extractBasename(path);
      return basename ? [{ path, basename }] : [];
    });
    if (!targets.length) {
      return new Map(keys.map(key => [key, []]));
    }

    log.debug('findReferencingFilesFallback for', targets.map(target => target.path).join(', '));

    const allFiles = await this.sourceFileCollector.collectAllSourceFiles(this.getRootDir());
    const concurrency = this.getConcurrency() ?? 8;
    const results = await mapWithConcurrency(allFiles, concurrency, filePath => {
      const others = targets.filter(target => target.path !== normalizePath(filePath));
      return others.length ? this.findReferencesInFile(filePath, others) : Promise.resolve([]);
    });
    const references = results.flat();
    log.debug('findReferencingFilesFallback found', references.length, 'referencing files');
    return new Map(keys.map(key => [key, references.filter(({ target }) => target === key).map(({ dependency }) => dependency)]));
  }

  private extractBasename(filePath: string): string | undefined {
    return filePath.split(/[/\\]/).pop()?.replace(/\.[^/.]+$/, '');
  }
}
