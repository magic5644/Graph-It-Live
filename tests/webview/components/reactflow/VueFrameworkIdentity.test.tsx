// @vitest-environment happy-dom
/**
 * Vue framework identity (#646): `.vue` files and the SFC component node keep the Vue green and logo in every graph,
 * readable in light, dark and high-contrast themes, distinct from React in a mixed workspace, with selection, cycle
 * and risk indicators kept.
 */
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FRAMEWORK_IDENTITIES, isFramework, LANGUAGE_COLORS, REACT_IDENTITY, VUE_IDENTITY } from '@/shared/constants';
import { contrastRatio, parseColor } from '@/webview/components/architecture/unitColors';
import { FileNode, type FileNodeData } from '@/webview/components/reactflow/FileNode';
import { SymbolNode, type SymbolNodeData } from '@/webview/components/reactflow/SymbolNode';
import { FrameworkBadges, frameworkName, LanguageIcon } from '@/webview/components/reactflow/LanguageIcon';
import { buildCallGraphStylesheet } from '@/webview/components/cytoscape/CytoscapeTheme';
import { AtomicSymbolGraph } from '@/webview/components/AtomicSymbolGraph';
import SymbolCardView from '@/webview/components/SymbolCardView';

vi.mock('reactflow', () => ({ Handle: () => null, Position: { Left: 'left', Right: 'right' } }));
afterEach(cleanup);

const noop = () => {};
const fileData: FileNodeData = {
  label: 'Card.vue', fullPath: '/src/Card.vue', framework: 'vue', isRoot: false,
  isParent: false, isInCycle: false, hasChildren: false, isExpanded: false,
  hasReferencingFiles: false, isParentsVisible: false, onNodeClick: noop,
  onDrillDown: noop, onFindReferences: noop, onToggle: noop, onExpandRequest: noop,
};
const symbolData: SymbolNodeData = {
  label: 'Card', fullPath: '/src/Card.vue:Card', framework: 'vue', kind: 'Function',
  category: 'function', line: 1, isExported: true, isRoot: false,
  onNodeClick: noop, onDrillDown: noop,
};

describe('Vue identity', () => {
  it('reuses the Vue language color and logo, with a text color readable on it', () => {
    expect(VUE_IDENTITY.color).toBe(LANGUAGE_COLORS.vue);
    expect(FRAMEWORK_IDENTITIES).toEqual({ react: REACT_IDENTITY, vue: VUE_IDENTITY });
    for (const identity of Object.values(FRAMEWORK_IDENTITIES)) {
      // WCAG AA for the node labels drawn on the framework fill.
      expect(contrastRatio(parseColor(identity.foreground)!, parseColor(identity.color)!)).toBeGreaterThanOrEqual(4.5);
    }
    render(<><LanguageIcon filePath="/src/Card.vue" label="Card.vue" framework="vue" /><LanguageIcon filePath="/src/Plain.vue" label="Plain.vue" /></>);
    // The same logo, with and without the framework evidence.
    expect(screen.getByLabelText('Vue file')).toBeTruthy();
    expect(screen.getByLabelText('vue file')).toBeTruthy();
  });

  it.each([
    ['react', true], ['vue', true], ['svelte', false], [undefined, false], [42, false], ['constructor', false],
  ])('reads %s back as a framework: %s', (value, expected) => {
    expect(isFramework(value)).toBe(expected);
  });

  it('names the framework for assistive technology, never by color alone', () => {
    expect(frameworkName('Card', 'vue')).toBe('Vue: Card');
    expect(frameworkName('Card', 'react')).toBe('React: Card');
    expect(frameworkName('Card')).toBeUndefined();
  });

  it.each([false, true])('preserves selected=%s, cycle and risk indicators on a Vue file', selected => {
    const data = { ...fileData, isInCycle: true, hubScore: 90, selectedNodeId: selected ? 'card' : undefined };
    const { container } = render(React.createElement(FileNode, { data, id: 'card' } as React.ComponentProps<typeof FileNode>));
    expect(screen.getByRole('button', { name: 'Vue: Card.vue' })).toBeTruthy();
    expect(screen.getByTitle('Part of circular dependency')).toBeTruthy();
    const body = container.querySelector('button > div:not([aria-label])') as HTMLElement;
    expect(body.style.border).toBe(selected ? '4px solid #0078d4' : `5px solid ${VUE_IDENTITY.color}`);
    // The outline uses the theme's contrast border, so high-contrast themes keep the selection visible.
    expect(body.style.outlineColor).toBe(selected ? 'var(--vscode-contrastActiveBorder, var(--vscode-editor-foreground))' : '');
  });

  it('gives a Vue component node its fill, logo and accessible name', () => {
    render(React.createElement(SymbolNode, { data: { ...symbolData, selectedNodeId: 'card' }, id: 'card' } as React.ComponentProps<typeof SymbolNode>));
    const button = screen.getByRole('button', { name: 'Vue: Card' });
    expect(button.style.border).toBe('4px solid #0078d4');
    expect(screen.getByAltText('Vue')).toBeTruthy();
  });

  it('shows Vue in the hierarchical symbol view and the symbol cards', () => {
    const symbols = [{ id: '/src/Card.vue:Card', name: 'Card', kind: 'FunctionDeclaration', category: 'function', line: 1, isExported: true, framework: 'vue' as const }];
    render(<AtomicSymbolGraph symbols={symbols} dependencies={[]} filePath="/src/Card.vue" onNodeClick={noop} />);
    expect(screen.getByRole('button', { name: 'Vue: Card' })).toBeTruthy();
    expect(screen.getByAltText('Vue')).toBeTruthy();
    cleanup();
    render(<SymbolCardView symbols={symbols} dependencies={[]} filePath="/src/Card.vue" referencingFiles={[]}
      showTypes={false} onShowTypesChange={noop} onSymbolClick={noop} onNavigateToFile={noop}
      onBack={noop} onSwitchToGraphView={noop} />);
    expect(screen.getByRole('button', { name: 'Vue: Card' })).toBeTruthy();
    expect(screen.getByAltText('Vue')).toBeTruthy();
  });

  it('keeps React and Vue apart in a mixed graph: one key each, React first, none for plain nodes', () => {
    const { container } = render(<FrameworkBadges frameworks={['vue', undefined, 'react', 'vue']} />);
    expect([...container.querySelectorAll('[data-testid$="-badge"]')].map(badge => badge.textContent)).toEqual(['React', 'Vue']);
    cleanup();
    expect(render(<FrameworkBadges frameworks={[undefined]} />).container.innerHTML).toBe('');
  });

  it.each([true, false])('draws Vue call graph nodes with their own fill, logo and selection border in dark=%s themes', dark => {
    const sheet = buildCallGraphStylesheet(dark);
    const style = (selector: string) => (sheet.find(item => 'selector' in item && item.selector === selector) as { style: Record<string, unknown> }).style;
    expect(style('node[framework="vue"]')).toMatchObject({ 'background-color': VUE_IDENTITY.color, color: VUE_IDENTITY.foreground });
    expect(style('node[framework="vue"]')['background-image']).toContain(encodeURIComponent(VUE_IDENTITY.svg));
    expect(style('node[framework="vue"]')['background-color']).not.toBe(style('node[framework="react"]')['background-color']);
    const selected = style('node[framework="vue"][?isRoot], node[framework="vue"]:selected');
    expect(selected['border-width']).toBe(4);
    expect(selected['border-color']).not.toBe(VUE_IDENTITY.color);
  });
});
