// @vitest-environment happy-dom
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactFlowProps } from 'reactflow';
import type { GraphData } from '../../../src/shared/types';

const flow = vi.hoisted(() => ({ props: {} as ReactFlowProps, fitView: vi.fn() }));
// Browser geometry is covered by the Electron test; keep real state hooks here.
vi.mock('reactflow', async (importOriginal) => {
  const actual = await importOriginal<typeof import('reactflow')>();
  return {
    ...actual,
    default: (props: ReactFlowProps) => { flow.props = props; return <div data-testid="pane" onClick={props.onPaneClick} />; },
    useReactFlow: () => ({ fitView: flow.fitView }),
    useNodesInitialized: () => true,
  };
});
vi.mock('reactflow/dist/style.css', () => ({ default: '' }));
import ReactFlowGraph from '../../../src/webview/components/ReactFlowGraph';
import * as builder from '../../../src/webview/components/reactflow/buildGraph';

const paths = ['a', 'b', 'c', 'd', 'x'].map(name => `/p/src/${name}/${name}.ts`);
const [a, b, c, d, x] = paths;
const data: GraphData = {
  nodes: paths,
  edges: [{ source: a, target: b }, { source: b, target: c }, { source: c, target: d }, { source: a, target: x }],
  nodeMetadata: Object.fromEntries(paths.map((p, i) => [p, { hubScore: 0, communityId: i + 1, communityKey: ['a', 'b', 'c', 'd', 'x'][i] }])),
};
const props = {
  data, currentFilePath: a, expandAll: true, onExpandAllChange: vi.fn(),
  onNodeClick: vi.fn(), onDrillDown: vi.fn(), onFindReferences: vi.fn(),
};
const node = (id: string) => flow.props.nodes!.find(n => n.id === id)!;
const edge = (source: string, target: string) => flow.props.edges!.find(e => e.source === source && e.target === target)!;
function clickEdge(source = a, target = b) {
  act(() => flow.props.onEdgeClick?.({} as React.MouseEvent, edge(source, target)));
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('file graph interactions', () => {
  it('restores dimmed elements on pane click without restoring excluded communities or moving nodes', () => {
    vi.useFakeTimers();
    const build = vi.spyOn(builder, 'buildReactFlowGraph');
    render(<ReactFlowGraph {...props} />);
    act(() => vi.advanceTimersByTime(500));
    act(() => flow.props.onNodesChange?.([{ id: a, type: 'position', position: { x: 123, y: 456 } }]));
    build.mockClear(); flow.fitView.mockClear();
    fireEvent.click(screen.getByRole('checkbox', { name: 'x (1)' }));
    expect(node(x).hidden).toBe(true);
    clickEdge();
    expect(node(d).style?.opacity).toBeLessThan(1);
    expect(node(c).style?.opacity ?? 1).toBe(1);
    expect(edge(c, d).style?.opacity).toBeLessThan(1);
    expect(flow.props.nodes).toHaveLength(5);
    fireEvent.click(screen.getByTestId('pane'));
    expect(node(d).style?.opacity ?? 1).toBe(1);
    expect(node(x).hidden).toBe(true);
    expect(flow.props.edges?.some(e => e.selected)).toBe(false);
    expect(node(a).position).toEqual({ x: 123, y: 456 });
    act(() => vi.advanceTimersByTime(2500));
    expect(build).not.toHaveBeenCalled();
    expect(flow.fitView).not.toHaveBeenCalled();
  });

  it('supports empty selection, restore all and suspension when communities are disabled', () => {
    const view = render(<ReactFlowGraph {...props} />);
    for (const box of screen.getAllByRole('checkbox')) fireEvent.click(box);
    expect(flow.props.nodes?.every(n => n.hidden)).toBe(true);
    expect(screen.getByText('No files visible. Select a group or show all.')).toBeTruthy();
    view.rerender(<ReactFlowGraph {...props} showCommunities={false} />);
    expect(flow.props.nodes?.some(n => n.hidden)).toBe(false);
    view.rerender(<ReactFlowGraph {...props} />);
    expect(flow.props.nodes?.every(n => n.hidden)).toBe(true);
    fireEvent.click(screen.getAllByRole('button', { name: 'Show all' })[0]);
    expect(flow.props.nodes?.some(n => n.hidden)).toBe(false);
  });

  it('toggles focus, replaces it, and clears it if the selected edge is hidden', () => {
    render(<ReactFlowGraph {...props} />);
    clickEdge(); clickEdge();
    expect(node(d).style?.opacity ?? 1).toBe(1);
    clickEdge(); clickEdge(c, d);
    expect(node(a).style?.opacity).toBeLessThan(1);
    fireEvent.click(screen.getByRole('checkbox', { name: 'c (1)' }));
    expect(node(a).style?.opacity ?? 1).toBe(1);
  });

  it('keeps domain exclusions across renumbering and shows new groups', () => {
    const view = render(<ReactFlowGraph {...props} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'b (1)' }));
    const extra = '/p/src/new/new.ts';
    const changed: GraphData = {
      ...data, nodes: [...paths, extra], edges: [...data.edges, { source: a, target: extra }],
      nodeMetadata: { ...data.nodeMetadata, [b]: { hubScore: 0, communityId: 20, communityKey: 'b' }, [extra]: { hubScore: 0, communityId: 2, communityKey: 'new' } },
    };
    view.rerender(<ReactFlowGraph {...props} data={changed} />);
    expect(node(b).hidden).toBe(true);
    expect(node(extra).hidden).toBeFalsy();
    view.rerender(<ReactFlowGraph {...props} data={changed} resetToken={1} />);
    expect(node(b).hidden).toBeFalsy();
  });

  it('applies only to files and leaves symbol mode unfiltered', () => {
    render(<ReactFlowGraph {...props} mode="symbol" />);
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(flow.props.onEdgeClick).toBeUndefined();
  });

  it('resets exclusions when returning from another view mode', () => {
    const view = render(<ReactFlowGraph {...props} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'b (1)' }));
    view.rerender(<ReactFlowGraph {...props} mode="symbol" />);
    view.rerender(<ReactFlowGraph {...props} mode="file" />);
    expect(node(b).hidden).toBe(false);
  });

  it('resets legacy exclusions on metadata changes and groups unassigned files', () => {
    const legacy = { ...data, nodeMetadata: { [a]: { hubScore: 0, communityId: 1 } } };
    const view = render(<ReactFlowGraph {...props} data={legacy} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Ungrouped (4)' }));
    expect(node(b).hidden).toBe(true);
    view.rerender(<ReactFlowGraph {...props} data={{ ...legacy, nodeMetadata: { ...legacy.nodeMetadata } }} />);
    expect(node(b).hidden).toBe(false);
  });

  it('preserves exclusions through collapse and focus through the expansion animation timeout', () => {
    vi.useFakeTimers();
    const view = render(<ReactFlowGraph {...props} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'd (1)' }));
    view.rerender(<ReactFlowGraph {...props} expandAll={false} />);
    view.rerender(<ReactFlowGraph {...props} expandAll />);
    expect(node(d).hidden).toBe(true);
    clickEdge();
    act(() => vi.advanceTimersByTime(2500));
    expect(node(d).hidden).toBe(true);
    expect(edge(a, b).selected).toBe(true);
  });

  it('honors unused-edge hiding and restores original dim styles after focus', () => {
    const unused = { ...data, unusedEdges: [`${c}->${d}`] };
    const view = render(<ReactFlowGraph {...props} data={unused} filterUnused unusedDependencyMode="dim" />);
    const original = edge(c, d).style;
    clickEdge();
    expect(edge(c, d).style?.opacity).toBeLessThan(Number(original?.opacity));
    fireEvent.click(screen.getByTestId('pane'));
    expect(edge(c, d).style).toEqual(original);
    view.rerender(<ReactFlowGraph {...props} data={unused} filterUnused unusedDependencyMode="hide" />);
    expect(flow.props.edges?.some(e => e.source === c && e.target === d)).toBe(false);
  });

  it('retains existing symbol highlighting and recursive edge styling', () => {
    const symbols = { ...data, nodes: [a, b, x], edges: [{ source: a, target: b }, { source: a, target: a }] };
    render(<ReactFlowGraph {...props} data={symbols} mode="symbol" symbolData={{ symbols: [], dependencies: [] }} />);
    expect(edge(a, a).label).toBe('🔄 récursif');
    act(() => node(a).data.onHighlight(a));
    expect(flow.props.nodes?.map(n => n.id)).toEqual([a, b]);
    expect(edge(a, b).style?.strokeWidth).toBe(2.5);
  });
});
