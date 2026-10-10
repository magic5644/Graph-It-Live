import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LanguageService } from '../../src/analyzer/LanguageService';
import { PythonParser } from '../../src/analyzer/languages/PythonParser';
import { PythonSymbolAnalyzer } from '../../src/analyzer/languages/PythonSymbolAnalyzer';
import { RustParser } from '../../src/analyzer/languages/RustParser';
import { RustSymbolAnalyzer } from '../../src/analyzer/languages/RustSymbolAnalyzer';
import { Spider } from '../../src/analyzer/Spider';

vi.mock('../../src/analyzer/languages/PythonParser', () => ({ PythonParser: vi.fn() }));
vi.mock('../../src/analyzer/languages/PythonSymbolAnalyzer', () => ({ PythonSymbolAnalyzer: vi.fn() }));
vi.mock('../../src/analyzer/languages/RustParser', () => ({ RustParser: vi.fn() }));
vi.mock('../../src/analyzer/languages/RustSymbolAnalyzer', () => ({ RustSymbolAnalyzer: vi.fn() }));

const tsFixturesDir = path.resolve(__dirname, '../fixtures/sample-project');

describe('LanguageService lazy parser loading', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not load the Python or Rust parsers when crawling a TypeScript-only project', async () => {
    const spider = new Spider({ rootDir: tsFixturesDir, maxDepth: 20 });

    const graph = await spider.crawl(path.join(tsFixturesDir, 'src', 'main.ts'));

    expect(graph.nodes.length).toBeGreaterThan(1);
    expect(PythonParser).not.toHaveBeenCalled();
    expect(PythonSymbolAnalyzer).not.toHaveBeenCalled();
    expect(RustParser).not.toHaveBeenCalled();
    expect(RustSymbolAnalyzer).not.toHaveBeenCalled();
  });

  it('loads a parser only on the first file of its language', () => {
    const rootDir = path.join(tsFixturesDir, 'lazy-loading-root');

    LanguageService.getAnalyzer(path.join(rootDir, 'app.py'), rootDir);
    LanguageService.getAnalyzer(path.join(rootDir, 'lib.pyi'), rootDir);
    LanguageService.getAnalyzer(String.raw`C:\repo\src\MAIN.RS`, rootDir);

    expect(PythonParser).toHaveBeenCalledTimes(1);
    expect(RustParser).toHaveBeenCalledTimes(1);
    expect(PythonSymbolAnalyzer).not.toHaveBeenCalled();
    expect(RustSymbolAnalyzer).not.toHaveBeenCalled();
  });
});
