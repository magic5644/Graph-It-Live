// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REACT_IDENTITY } from '@/shared/constants';
import { FileNode, type FileNodeData } from '@/webview/components/reactflow/FileNode';
import { SymbolNode, type SymbolNodeData } from '@/webview/components/reactflow/SymbolNode';
import { LanguageIcon, ReactBadge } from '@/webview/components/reactflow/LanguageIcon';
import { buildCallGraphStylesheet } from '@/webview/components/cytoscape/CytoscapeTheme';
import { buildReactFlowGraph } from '@/webview/components/reactflow/buildGraph';
import { AtomicSymbolGraph } from '@/webview/components/AtomicSymbolGraph';
import SymbolCardView from '@/webview/components/SymbolCardView';
import type { SymbolInfo } from '@/shared/symbol-types';

vi.mock('reactflow', () => ({ Handle: () => null, Position: { Left: 'left', Right: 'right' } }));
afterEach(cleanup);

const noop = () => {};
const fileData: FileNodeData = {
  label: 'Card.tsx', fullPath: '/src/Card.tsx', framework: 'react', isRoot: false,
  isParent: false, isInCycle: false, hasChildren: false, isExpanded: false,
  hasReferencingFiles: false, isParentsVisible: false, onNodeClick: noop,
  onDrillDown: noop, onFindReferences: noop, onToggle: noop, onExpandRequest: noop,
};
const symbolData: SymbolNodeData = {
  label: 'Card', fullPath: '/src/Card.tsx:Card', framework: 'react', kind: 'Function',
  category: 'function', line: 1, isExported: true, isRoot: false,
  onNodeClick: noop, onDrillDown: noop,
};
const symbols: SymbolInfo[] = [{
  id: '/src/Card.tsx:Card', name: 'Card', kind: 'FunctionDeclaration', category: 'function',
  line: 1, isExported: true, framework: 'react',
}];

describe('proven React identity', () => {
  it.each(['.tsx', '.jsx', '.ts', '.js'])('uses evidence rather than the %s extension', extension => {
    render(<LanguageIcon filePath={`/src/Card${extension}`} label={`Card${extension}`} framework="react" />);
    expect(screen.getByLabelText('React file')).toBeTruthy();
  });

  it.each([['Card.tsx', 'typescript'], ['Card.jsx', 'javascript'], ['Card.vue', 'vue'], ['notes.txt', 'file']])(
    'keeps %s unchanged without evidence, including old payloads', (label, language) => {
      render(<LanguageIcon filePath={`/src/${label}`} label={label} />);
      expect(screen.getByLabelText(`${language} file`)).toBeTruthy();
      expect(screen.queryByLabelText('React file')).toBeNull();
    },
  );

  it.each([false, true])('preserves selected=%s, cycle and risk indicators on a React file', selected => {
    const data = { ...fileData, isInCycle: true, hubScore: 90, selectedNodeId: selected ? 'card' : undefined };
    const { container } = render(React.createElement(FileNode, { data, id: 'card' } as React.ComponentProps<typeof FileNode>));
    expect(screen.getByRole('button', { name: 'React: Card.tsx' })).toBeTruthy();
    expect(screen.getByTitle('Part of circular dependency')).toBeTruthy();
    const body = container.querySelector('button > div:not([aria-label])') as HTMLElement;
    expect(body.style.border).toBe(selected ? '4px solid #0078d4' : `5px solid ${REACT_IDENTITY.color}`);
    expect(body.style.outlineStyle).toBe(selected ? 'solid' : '');
  });

  it('gives a React symbol an accessible framework name and preserves selection', () => {
    const data = { ...symbolData, selectedNodeId: 'card' };
    render(React.createElement(SymbolNode, { data, id: 'card' } as React.ComponentProps<typeof SymbolNode>));
    const button = screen.getByRole('button', { name: 'React: Card' });
    expect(button.style.border).toBe('4px solid #0078d4');
    expect(screen.getByAltText('React')).toBeTruthy();
  });

  it('keeps React, plain TypeScript and Vue identities together', () => {
    render(<><LanguageIcon filePath="/src/Card.tsx" label="Card.tsx" framework="react" />
      <LanguageIcon filePath="/src/utility.ts" label="utility.ts" />
      <LanguageIcon filePath="/src/Card.vue" label="Card.vue" /></>);
    expect(['React', 'typescript', 'vue'].map(name => screen.getByLabelText(`${name} file`))).toHaveLength(3);
  });

  it('refreshes a memoized file node when evidence arrives or disappears', () => {
    const props = { data: fileData, id: 'card' } as React.ComponentProps<typeof FileNode>;
    const { rerender } = render(React.createElement(FileNode, props));
    expect(screen.getByRole('button', { name: 'React: Card.tsx' })).toBeTruthy();
    rerender(React.createElement(FileNode, { ...props, data: { ...fileData, framework: undefined } }));
    expect(screen.queryByLabelText('React file')).toBeNull();
    expect(screen.getByLabelText('typescript file')).toBeTruthy();
  });

  it.each(['file', 'symbol'] as const)('transports evidence into the %s ReactFlow builder', mode => {
    const path = mode === 'file' ? 'C:\\src\\Card.tsx' : symbols[0].id;
    const result = buildReactFlowGraph({
      data: { nodes: [path], edges: [], nodeMetadata: { 'c:/src/Card.tsx': { hubScore: 0.9, framework: 'react' } } },
      mode, symbolData: { symbols, dependencies: [] }, currentFilePath: path,
      expandAll: true, expandedNodes: new Set(), showParents: false,
      callbacks: { onNodeClick: noop, onDrillDown: noop, onFindReferences: noop,
        onToggle: noop, onExpandRequest: noop },
    });
    expect(result.nodes[0].data.framework).toBe('react');
  });

  it('includes the framework in the hierarchical symbol view', () => {
    render(<AtomicSymbolGraph symbols={symbols} dependencies={[]} filePath="/src/Card.tsx" onNodeClick={noop} />);
    expect(screen.getByRole('button', { name: 'React: Card' })).toBeTruthy();
    expect(screen.getByAltText('React')).toBeTruthy();
  });

  it('includes the framework in symbol cards', () => {
    render(<SymbolCardView symbols={symbols} dependencies={[]} filePath="/src/Card.tsx" referencingFiles={[]}
      showTypes={false} onShowTypesChange={noop} onSymbolClick={noop} onNavigateToFile={noop}
      onBack={noop} onSwitchToGraphView={noop} />);
    expect(screen.getByRole('button', { name: 'React: Card' })).toBeTruthy();
    expect(screen.getByAltText('React')).toBeTruthy();
  });

  it('identifies a React member without changing its plain class card', () => {
    const members = [
      { ...symbols[0], id: 'parent', name: 'Container', category: 'class' as const, framework: undefined },
      { ...symbols[0], parentSymbolId: 'parent' },
    ];
    render(<SymbolCardView symbols={members} dependencies={[]} filePath="/src/Card.tsx" referencingFiles={[]}
      showTypes={false} onShowTypesChange={noop} onSymbolClick={noop} onNavigateToFile={noop}
      onBack={noop} onSwitchToGraphView={noop} />);
    expect(screen.getByRole('button', { name: 'React: Card' })).toBeTruthy();
    expect(screen.getByText('Container')).toBeTruthy();
  });

  it.each([undefined, { position: 'absolute' as const, top: '12px' }])('shows the shared React badge with style %o', style => {
    render(<ReactBadge style={style} />);
    const badge = screen.getByTestId('react-badge');
    expect(badge.textContent).toBe('React');
    expect(screen.getByAltText('React')).toBeTruthy();
    expect(badge.style.position).toBe(style?.position ?? '');
  });

  it.each([true, false])('uses the shared icon and readable foreground in dark=%s call graphs', dark => {
    const sheet = buildCallGraphStylesheet(dark);
    const entry = sheet.find(item => 'selector' in item && item.selector === 'node[framework="react"]') as { style: Record<string, unknown> };
    expect(entry.style).toMatchObject({ 'background-color': REACT_IDENTITY.color, color: REACT_IDENTITY.foreground });
    expect(entry.style['background-image']).toContain(encodeURIComponent(REACT_IDENTITY.svg));
  });
});
