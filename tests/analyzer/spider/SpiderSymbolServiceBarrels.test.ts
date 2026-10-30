import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AstWorkerHost } from '@/analyzer/ast/AstWorkerHost';
import { Cache } from '@/analyzer/Cache';
import type { FileReader } from '@/analyzer/FileReader';
import type { LanguageService } from '@/analyzer/LanguageService';
import { SpiderSymbolService } from '@/analyzer/spider/SpiderSymbolService';
import type { SymbolDependencyHelper } from '@/analyzer/SymbolDependencyHelper';
import type { Dependency, SpiderConfig, SymbolDependency, SymbolInfo } from '@/analyzer/types';
import type { PathResolver } from '@/analyzer/utils/PathResolver';
import { normalizePath } from '@/shared/path';

// Windows-style paths: the service must compare and key them through normalizePath.
const A = String.raw`C:\ws\lib\a.ts`;
const NSX = String.raw`C:\ws\lib\nsx.ts`;
const BARREL = String.raw`C:\ws\lib\index.ts`;
const APP = String.raw`C:\ws\app.ts`;

const symbol = (file: string, name: string): SymbolInfo => ({
  name,
  kind: 'FunctionDeclaration',
  line: 1,
  isExported: true,
  id: `${normalizePath(file)}:${name}`,
});

const dependency = (target: string, name: string): SymbolDependency => ({
  sourceSymbolId: `${normalizePath(APP)}:(file)`,
  targetSymbolId: `${normalizePath(target)}:${name}`,
  targetFilePath: target,
  line: 1,
  isTypeOnly: false,
});

const OTHER = String.raw`C:\ws\other.ts`;

interface World {
  barrelSource: string;
  appSource: string;
  appDependencies: SymbolDependency[];
  symbols: Record<string, SymbolInfo[]>;
  /** Files whose read rejects. */
  unreadable?: string[];
}

function buildService(world: World): SpiderSymbolService {
  const files: Record<string, string> = { [BARREL]: world.barrelSource, [APP]: world.appSource };
  const refs: Record<string, Dependency[]> = {
    [normalizePath(A)]: [{ path: BARREL, type: 'export', line: 1, module: './a' }],
    [normalizePath(NSX)]: [{ path: BARREL, type: 'export', line: 1, module: './nsx' }],
    [normalizePath(BARREL)]: [{ path: APP, type: 'import', line: 1, module: './lib' }],
  };
  const specifiers: Record<string, string> = { './a': A, './nsx': NSX, './lib': BARREL, './other': OTHER };
  const helper = {
    buildUsedSymbolId: (file: string, name: string) => `${normalizePath(file)}:${name}`,
    extractSymbolName: (id: string) => id.split(':').pop() ?? '',
    doesDependencyTargetFile: async (dep: SymbolDependency, _from: string, target: string) =>
      normalizePath(dep.targetFilePath) === normalizePath(target),
  };
  const service = new SpiderSymbolService(
    { getInternalExportDependencyGraph: vi.fn().mockResolvedValue(new Map()) } as unknown as AstWorkerHost,
    new Cache<{ symbols: SymbolInfo[]; dependencies: SymbolDependency[] }>({ maxSize: 10 }),
    { readFile: vi.fn(async (file: string) => {
      if (world.unreadable?.some((u) => normalizePath(u) === normalizePath(file))) throw new Error('EACCES');
      return files[file] ?? files[Object.keys(files).find((k) => normalizePath(k) === normalizePath(file)) ?? ''] ?? '';
    }) } as unknown as FileReader,
    { resolve: vi.fn(async (_from: string, specifier: string) => specifiers[specifier] ?? null) } as unknown as PathResolver,
    helper as unknown as SymbolDependencyHelper,
    () => ({ rootDir: String.raw`C:\ws` }) as SpiderConfig,
    async (file: string) => refs[normalizePath(file)] ?? [],
    {} as LanguageService,
  );
  vi.spyOn(service, 'getSymbolGraph').mockImplementation(async (file: string) => ({
    symbols: world.symbols[normalizePath(file)] ?? [],
    dependencies: normalizePath(file) === normalizePath(APP) ? world.appDependencies : [],
  }));
  return service;
}

describe('SpiderSymbolService barrel usage with Windows paths (#513)', () => {
  let world: World;

  beforeEach(() => {
    world = {
      barrelSource: "export * from './a';\nexport * as ns from './nsx';\n",
      appSource: "import { starUsed, ns } from './lib';\nstarUsed(); ns.nsx();\n",
      appDependencies: [dependency(BARREL, 'starUsed'), dependency(BARREL, 'ns')],
      symbols: {
        [normalizePath(A)]: [symbol(A, 'starUsed'), symbol(A, 'dead')],
        [normalizePath(NSX)]: [symbol(NSX, 'nsx'), symbol(NSX, 'deadInNs')],
      },
    };
  });

  it('credits a symbol imported through a barrel whose paths use backslashes', async () => {
    const unused = await buildService(world).findUnusedSymbols(A);
    expect(unused.map((s) => s.name)).toEqual(['dead']);
  });

  it('credits only the namespace members the consumer accesses', async () => {
    const unused = await buildService(world).findUnusedSymbols(NSX);
    expect(unused.map((s) => s.name)).toEqual(['deadInNs']);
  });

  it('credits every member when the namespace is used as a whole', async () => {
    world.appSource = "import { ns } from './lib';\nconsole.log(Object.keys(ns));\n";
    const unused = await buildService(world).findUnusedSymbols(NSX);
    expect(unused).toEqual([]);
  });

  it('credits every member when the barrel is imported with `import * as`', async () => {
    world.appSource = "import * as lib from './lib';\nlib.ns.nsx();\n";
    const unused = await buildService(world).findUnusedSymbols(NSX);
    expect(unused).toEqual([]);
  });

  it('reports every member when the namespace is never imported', async () => {
    world.appSource = "import { starUsed } from './lib';\nstarUsed();\n";
    world.appDependencies = [dependency(BARREL, 'starUsed')];
    const unused = await buildService(world).findUnusedSymbols(NSX);
    expect(unused.map((s) => s.name)).toEqual(['nsx', 'deadInNs']);
  });

  it('follows a renamed namespace import', async () => {
    world.appSource = "import { ns as q } from './lib';\nq.nsx();\n";
    const unused = await buildService(world).findUnusedSymbols(NSX);
    expect(unused.map((s) => s.name)).toEqual(['deadInNs']);
  });

  it('ignores a same-named import from another module', async () => {
    world.appSource = "import { ns } from './other';\nns.nsx();\n";
    const unused = await buildService(world).findUnusedSymbols(NSX);
    expect(unused.map((s) => s.name)).toEqual(['nsx', 'deadInNs']);
  });

  it('reports the symbol instead of throwing when the importer cannot be read', async () => {
    world.unreadable = [APP];
    const unused = await buildService(world).findUnusedSymbols(NSX);
    expect(unused.map((s) => s.name)).toEqual(['nsx', 'deadInNs']);
  });

  it('skips a barrel that cannot be read', async () => {
    world.unreadable = [BARREL];
    const unused = await buildService(world).findUnusedSymbols(A);
    expect(unused.map((s) => s.name)).toEqual(['starUsed', 'dead']);
  });
});
