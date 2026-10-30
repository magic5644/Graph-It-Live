import { SourceFileCollector } from './SourceFileCollector';
import { mapWithConcurrency } from '../shared/concurrency';
import { getLogger } from '../shared/logger';
import { Dependency, normalizePath } from './types';

const log = getLogger('ReferencingFilesFinder');

interface ReferencingFilesFinderOptions {
  sourceFileCollector: SourceFileCollector;
  getRootDir: () => string;
  getConcurrency: () => number | undefined;
  findReferenceInFile: (
    filePath: string,
    normalizedTargetPath: string,
    targetBasename: string
  ) => Promise<Dependency | null>;
}

/**
 * Fallback reverse-reference finder used when the reverse index is unavailable.
 */
export class ReferencingFilesFinder {
  private readonly sourceFileCollector: SourceFileCollector;
  private readonly getRootDir: () => string;
  private readonly getConcurrency: () => number | undefined;
  private readonly findReferenceInFile: ReferencingFilesFinderOptions['findReferenceInFile'];

  constructor(options: ReferencingFilesFinderOptions) {
    this.sourceFileCollector = options.sourceFileCollector;
    this.getRootDir = options.getRootDir;
    this.getConcurrency = options.getConcurrency;
    this.findReferenceInFile = options.findReferenceInFile;
  }

  async findReferencingFilesFallback(targetPath: string): Promise<Dependency[]> {
    const normalizedTargetPath = normalizePath(targetPath);
    const targetBasename = this.extractBasename(normalizedTargetPath);

    if (!targetBasename) {
      return [];
    }

    log.debug('findReferencingFilesFallback for', normalizedTargetPath, 'basename:', targetBasename);

    const allFiles = await this.sourceFileCollector.collectAllSourceFiles(this.getRootDir());
    const concurrency = this.getConcurrency() ?? 8;
    const candidates = allFiles.filter(filePath => normalizePath(filePath) !== normalizedTargetPath);
    const results = await mapWithConcurrency(candidates, concurrency, filePath =>
      this.findReferenceInFile(filePath, normalizedTargetPath, targetBasename)
    );
    const referencingFiles = results.filter((result): result is Dependency => result !== null);

    log.debug('findReferencingFilesFallback found', referencingFiles.length, 'referencing files');
    return referencingFiles;
  }

  private extractBasename(filePath: string): string | undefined {
    return filePath.split(/[/\\]/).pop()?.replace(/\.[^/.]+$/, '');
  }
}
