import { beforeAll, describe, expect, it } from 'vitest';
import { RustSymbolAnalyzer } from '@/analyzer/languages/RustSymbolAnalyzer';
import { normalizePath } from '@/shared/path';

// Real tree-sitter WASM (dist/wasm).
describe('RustSymbolAnalyzer - calls outside any function (#514)', () => {
  const file = normalizePath('/ws/src/main.rs');
  const analyzer = new RustSymbolAnalyzer(process.cwd());

  beforeAll(async () => {
    await analyzer.ensureInitialized();
  });

  /** Source scope of each dependency; the target specifier format is the resolver's concern. */
  const sources = (code: string): string[] =>
    analyzer.analyzeFileContent(file, code).dependencies.map((d) => d.sourceSymbolId);

  it('attributes a const initialiser call to the file scope', () => {
    expect(sources('use helpers::init;\nconst LIMIT: u32 = init();\n')).toEqual([`${file}:(file)`]);
  });

  it('keeps the enclosing function as source inside a function', () => {
    expect(sources('use helpers::init;\nfn main() { init(); }\n')).toEqual([`${file}:main`]);
  });

  it('yields nothing for an empty file', () => {
    expect(sources('')).toEqual([]);
  });
});
