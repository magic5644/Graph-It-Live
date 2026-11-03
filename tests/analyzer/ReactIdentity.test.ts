import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { analyzeReactIdentity, collectReactReferencingPaths, enrichReactFramework, enrichReactSymbols, readReactJsxImportSource } from '@/analyzer/ReactIdentity';
import type { GraphData } from '@/shared/graph-types';
import { normalizePath } from '@/shared/path';

describe('React identity evidence', () => {
  it.each([
    ['tsx', `import React from 'react'; export function Card() { return <div />; }`, ['Card']],
    ['jsx', `import React from 'react'; export const Card = () => <div />; export function utility() { return 1; }`, ['Card']],
    ['tsx', `export function Card() { return <div />; }`, []],
    ['tsx', `import React from 'react'; export const count = 1;`, []],
    ['jsx', `import React from 'react'; import { h } from 'preact'; export const Card = () => <div />;`, []],
    ['jsx', `/** @jsxImportSource solid-js */ import React from 'react'; export const Card = () => <div />;`, []],
    ['tsx', `/** @jsxImportSource react */ export const Card = () => <div />;`, ['Card']],
    ['ts', `import { memo as remember } from 'react'; export const Card = remember(() => null);`, ['Card']],
    ['ts', `import * as R from 'react'; export const Card = R.lazy(() => import('./Card'));`, ['Card']],
    ['ts', `const memo = (value: unknown) => value; export const Card = memo(() => null);`, []],
    ['tsx', `import React from 'react'; export class Card { render() { return <div />; } }`, ['Card']],
    ['tsx', `import React from 'react'; function Card() { return null; } export function App() { return <Card />; }`, ['Card', 'App']],
    ['tsx', `import React from 'react'; function save() {} export const App = () => <button onClick={save} />;`, ['App']],
    ['tsx', `import React from 'react'; export function utility() { return () => <div />; }`, []],
    ['vue', `import React from 'react'; export const Card = () => <div />;`, []],
    ['tsx', `import React from 'react'; function renderRow() { return <li />; } export const handler = () => <div />;`, []],
    ['tsx', `import React from 'react'; export default function () { return <div />; }`, ['default']],
    ['tsx', `/** @jsxImportSource @emotion/react */ export const Card = () => <div />;`, ['Card']],
    ['tsx', `/** @jsxImportSource @theme-ui/core */ import { useState } from 'react'; export const Card = () => <div />;`, ['Card']],
  ])('recognizes only proven components in .%s: %s', (extension, source, expected) => {
    const result = analyzeReactIdentity(`C:/repo/Card.${extension}`, source);
    expect(result.components.map(component => component.name).sort()).toEqual([...expected].sort());
  });

  it('uses an explicit React automatic-runtime configuration without marking utilities', () => {
    const result = analyzeReactIdentity('/repo/Card.tsx', `export const Card = () => <div />; export const count = 1;`, 'react');
    expect(result.components.map(component => component.name)).toEqual(['Card']);
  });

  it.each([
    ['without any runtime hint', `export const Card = () => <div />;`, undefined, { eligible: true, isReact: false }],
    ['with a React-based configured runtime', `export const Card = () => <div />;`, '@emotion/react', { eligible: true, isReact: true }],
    ['with a competing configured runtime', `export const Card = () => <div />;`, 'preact', { eligible: false, isReact: false }],
    ['with an unknown configured runtime', `export const Card = () => <div />;`, '@theme-ui/core', { eligible: true, isReact: false }],
  ])('classifies a file %s', (_case, source, runtime, expected) => {
    expect(analyzeReactIdentity('/repo/Card.tsx', source, runtime)).toMatchObject(expected);
  });

  it('collects normalized JSX evidence paths once, skips other languages and files without importers', () => {
    const looked: string[] = [];
    const paths = collectReactReferencingPaths(['/repo/Card.ts', String.raw`\repo\Card.ts`, '/repo/lonely.tsx', '/repo/view.vue'], filePath => {
      looked.push(filePath);
      return filePath.endsWith('Card.ts') ? [{ path: '/repo/App.tsx' }, { path: String.raw`\repo\App.tsx` }] : [];
    });
    expect(paths).toEqual(['/repo/App.tsx']);
    expect(looked).toEqual(['/repo/Card.ts', '/repo/lonely.tsx']);
  });
});

describe('file graph React enrichment', () => {
  let root: string | undefined;
  afterEach(async () => { if (root) await fs.rm(root, { recursive: true, force: true }); });

  it('resolves JSX targets through a barrel, keeps callbacks and Vue unchanged, and clears stale evidence', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'gil-react-identity-'));
    const files: Record<string, string> = {
      'Card.ts': `export function Card() { return null; } export function save() {}`,
      'index.ts': `export { Card, save } from './Card';`,
      'App.tsx': `import React from 'react'; import { Card, save } from './index'; export function App() { return <Card onClick={save} />; }`,
      'Other.jsx': `import { h } from 'preact'; export const Other = () => <div />;`,
      'View.vue': `<template><div /></template>`,
    };
    await Promise.all(Object.entries(files).map(([name, source]) => fs.writeFile(path.join(root!, name), source)));
    const nodes = Object.keys(files).map(name => path.join(root!, name));
    const graph: GraphData = { nodes, edges: [], nodeMetadata: Object.fromEntries(nodes.map(node => [normalizePath(node), { hubScore: 0 }])) };
    await enrichReactFramework(graph, root);
    expect(nodes.filter(node => graph.nodeMetadata?.[normalizePath(node)]?.framework === 'react').map(node => path.basename(node)).sort()).toEqual(['App.tsx', 'Card.ts']);
    const symbols: Array<{ name: string; line: number; framework?: 'react' }> = [{ name: 'Card', line: 1 }, { name: 'save', line: 1 }];
    await enrichReactSymbols(symbols, path.join(root, 'Card.ts'), [path.join(root, 'App.tsx')], root);
    expect(symbols.filter(symbol => symbol.framework).map(symbol => symbol.name)).toEqual(['Card']);
    await fs.writeFile(path.join(root, 'App.tsx'), `export const count = 1;`);
    await enrichReactFramework(graph, root);
    expect(nodes.some(node => graph.nodeMetadata?.[normalizePath(node)]?.framework)).toBe(false);
    await enrichReactSymbols(symbols, path.join(root, 'Card.ts'), [path.join(root, 'App.tsx')], root);
    expect(symbols.some(symbol => symbol.framework)).toBe(false);
  });
});

describe('React runtime configuration and evidence safety', () => {
  let root: string | undefined;
  afterEach(async () => { if (root) await fs.rm(root, { recursive: true, force: true }); });
  const tmp = async () => (root = await fs.mkdtemp(path.join(os.tmpdir(), 'gil-react-runtime-')));

  it.each([
    [`{ "compilerOptions": { "jsx": "react-jsx" } }`, 'react'],
    [`{ "compilerOptions": { "jsx": "react-jsxdev" } }`, 'react'],
    [`{ "compilerOptions": { "jsx": "react-jsx", "jsxImportSource": "preact" } }`, 'preact'],
    [`{ "compilerOptions": { "jsx": "preserve" } }`, undefined],
    [`{ "compilerOptions": null }`, undefined],
    [`{}`, undefined],
  ])('reads %s as runtime %s', async (config, expected) => {
    const dir = await tmp();
    await fs.writeFile(path.join(dir, 'tsconfig.json'), config);
    expect(await readReactJsxImportSource(dir)).toBe(expected);
  });

  it('returns no runtime without a tsconfig.json', async () => {
    expect(await readReactJsxImportSource(await tmp())).toBeUndefined();
  });

  it('keeps parsed evidence for an unchanged file and refreshes it when the file changes', async () => {
    const dir = await tmp();
    const card = path.join(dir, 'Card.tsx');
    await fs.writeFile(card, `import React from 'react'; export const Card = () => <i />;`);
    const mtime = new Date(1_700_000_000_000);
    await fs.utimes(card, mtime, mtime);
    // Metadata keys are normalized in production (computeNodeMetadata): `c:/...` on Windows.
    const key = normalizePath(card);
    const graph: GraphData = { nodes: [card], edges: [], nodeMetadata: { [key]: { hubScore: 0 } } };
    await enrichReactFramework(graph, dir);
    expect(graph.nodeMetadata?.[key]?.framework).toBe('react');
    await fs.writeFile(card, `import React from 'react'; export const card = () => <i />;`);
    await fs.utimes(card, mtime, mtime);
    await enrichReactFramework(graph, dir);
    expect(graph.nodeMetadata?.[key]?.framework).toBe('react');
    await fs.utimes(card, mtime, new Date(mtime.getTime() + 5000));
    await enrichReactFramework(graph, dir);
    expect(graph.nodeMetadata?.[key]?.framework).toBeUndefined();
  });

  it('never follows a JSX import that resolves outside the workspace root', async () => {
    const dir = await tmp();
    const workspace = path.join(dir, 'ws');
    await fs.mkdir(workspace);
    await fs.writeFile(path.join(dir, 'Outside.ts'), `export function Outside() { return null; }`);
    const app = path.join(workspace, 'App.tsx');
    await fs.writeFile(app, `import React from 'react'; import { Outside } from '../Outside'; export const App = () => <Outside />;`);
    const symbols: Array<{ name: string; line: number; framework?: 'react' }> = [{ name: 'Outside', line: 1 }];
    await enrichReactSymbols(symbols, path.join(dir, 'Outside.ts'), [app], workspace);
    expect(symbols[0].framework).toBeUndefined();
  });
});
