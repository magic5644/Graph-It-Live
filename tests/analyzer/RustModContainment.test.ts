import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildArchitectureGraph } from '@/analyzer/architecture/ArchitectureGraphBuilder';
import { BranchWatchAnalyzer } from '@/analyzer/BranchWatchAnalyzer';
import { RustParser } from '@/analyzer/languages/RustParser';
import { Spider } from '@/analyzer/Spider';
import { normalizePath } from '@/analyzer/types';
import { detectCircularDependencies } from '@/mcp/shared/helpers';
import { detectCycleEdges } from '@/shared/cycleUtils';

/** A Rust `mod x;` is containment, not a use: it never closes a file cycle (#595). */
describe('Rust mod declarations are containment (#595)', () => {
  const files: Record<string, string> = {
    // lib.rs declares and re-exports its children; they use a crate-root item back.
    'facade/Cargo.toml': '[package]\nname = "facade"\nversion = "0.1.0"\n',
    'facade/src/lib.rs': 'mod a;\nmod b;\nmod net;\npub use a::alpha;\npub use self::b::beta;\npub struct Error;\n',
    'facade/src/a.rs': 'use crate::{Error};\npub fn alpha() -> Error { Error }\n#[cfg(test)]\nmod tests { use super::*; }\n',
    'facade/src/b.rs': 'use crate::Error;\npub fn beta() -> Error { Error }\n',
    // nested mod.rs: net declares tcp, tcp uses net's item.
    'facade/src/net/mod.rs': 'mod tcp;\npub use tcp::connect;\npub struct Conn;\n',
    'facade/src/net/tcp.rs': 'use super::Conn;\npub fn connect() -> Conn { Conn }\n',
    // A use written before the declaration it names.
    'facade/src/late.rs': 'pub use inner::f;\nmod inner;\n',
    'facade/src/late/inner.rs': 'pub fn f() {}\n',
    // A real usage cycle between two siblings.
    'usage/Cargo.toml': '[package]\nname = "usage"\nversion = "0.1.0"\n',
    'usage/src/lib.rs': 'mod a;\nmod b;\n',
    'usage/src/a.rs': 'pub fn g() { crate::b::f(); }\n',
    'usage/src/b.rs': 'pub fn f() { crate::a::g(); }\n',
  };
  let root = '';
  let spider: Spider;
  const at = (rel: string) => path.join(root, ...rel.split('/'));
  const rel = (file: string) => normalizePath(path.relative(root, file)).replaceAll('\\', '/');

  beforeAll(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gitl-rust-mod-')));
    await Promise.all(Object.entries(files).map(async ([file, content]) => {
      await fs.mkdir(path.dirname(at(file)), { recursive: true });
      await fs.writeFile(at(file), content, 'utf-8');
    }));
    spider = new Spider({ rootDir: root, extensionPath: process.cwd(), enableReverseIndex: true });
    await spider.buildFullIndex();
  }, 120_000);
  afterAll(async () => {
    await spider?.dispose();
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it('parses `mod x;` as a mod dependency listed first, and an inline `mod {}` as none', async () => {
    const parser = new RustParser(process.cwd());
    const lib = await parser.parseImports(at('facade/src/lib.rs'));
    expect(lib.slice(0, 3).map((d) => [d.type, d.module])).toEqual([['mod', 'a'], ['mod', 'b'], ['mod', 'net']]);
    expect(lib.slice(3).every((d) => d.type === 'import')).toBe(true);
    const a = await parser.parseImports(at('facade/src/a.rs'));
    expect(a.some((d) => d.type === 'mod')).toBe(false);
  }, 60_000);

  it('makes a use written before `mod x;` containment too, without a duplicate edge', async () => {
    const parsed = await new RustParser(process.cwd()).parseImports(at('facade/src/late.rs'));
    expect(parsed[0]).toMatchObject({ type: 'mod', module: 'inner' });
    expect(parsed.filter((d) => d.module === 'inner')).toHaveLength(1);
    const resolved = await spider.analyze(at('facade/src/late.rs'));
    expect(resolved.map((d) => [rel(d.path), d.type])).toEqual([['facade/src/late/inner.rs', 'mod']]);
  }, 60_000);

  it('keeps mod edges in the crawl, marked containment, and reports no facade cycle', async () => {
    const graph = await spider.crawl(at('facade/src/lib.rs'), { maxDepth: 10 });
    const edges = graph.edges.map((e) => [rel(e.source), rel(e.target), e.relationType]);
    expect(edges).toEqual(expect.arrayContaining([
      ['facade/src/lib.rs', 'facade/src/a.rs', 'containment'],
      ['facade/src/a.rs', 'facade/src/lib.rs', undefined],
      ['facade/src/net/mod.rs', 'facade/src/net/tcp.rs', 'containment'],
      ['facade/src/net/tcp.rs', 'facade/src/net/mod.rs', undefined],
    ]));
    expect(detectCircularDependencies(graph.edges)).toEqual([]);
    expect(detectCycleEdges(graph.edges).size).toBe(0);
  }, 60_000);

  it('still reports a real usage cycle between sibling modules', async () => {
    const graph = await spider.crawl(at('usage/src/lib.rs'), { maxDepth: 10 });
    const cycles = detectCircularDependencies(graph.edges).map((cycle) => cycle.map(rel));
    expect(cycles).toContainEqual(['usage/src/a.rs', 'usage/src/b.rs', 'usage/src/a.rs']);
    expect([...detectCycleEdges(graph.edges)]).toHaveLength(2);
  }, 60_000);

  it('lists the declaring parent as a mod referencer of the child', async () => {
    const refs = await spider.findReferencingFiles(at('facade/src/a.rs'));
    expect(refs.map((r) => [rel(r.path), r.type])).toContainEqual(['facade/src/lib.rs', 'mod']);
  }, 60_000);

  it('leaves mod declarations out of the architecture graph', async () => {
    const graph = await buildArchitectureGraph(root, (file) => spider.analyze(file));
    const edges = graph.edges.map((e) => `${e.sourceRelative}->${e.targetRelative}`);
    expect(edges).toContain('facade/src/net/tcp.rs->facade/src/net/mod.rs');
    expect(edges).not.toContain('facade/src/net/mod.rs->facade/src/net/tcp.rs');
    expect(edges).not.toContain('facade/src/lib.rs->facade/src/net/mod.rs');
  }, 60_000);

  it('Branch Watch / review-pr cycles skip containment and keep usage cycles', async () => {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf-8' }).trim();
    git('init', '-q');
    git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'add', '.');
    git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'base');
    const sha = git('rev-parse', 'HEAD');
    const analyzer = new BranchWatchAnalyzer(root, undefined, process.cwd());
    const facade = await analyzer.buildCycles({ changes: [{ path: 'facade/src/lib.rs', kind: 'modified' }], mergeBaseSha: sha }, []);
    expect(facade.summary).toEqual({ detected: 0, scopeComplete: true });
    const usage = await analyzer.buildCycles({ changes: [{ path: 'usage/src/a.rs', kind: 'modified' }], mergeBaseSha: sha }, []);
    expect(usage.summary.detected).toBe(1);
  }, 120_000);
});
