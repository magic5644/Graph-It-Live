/**
 * CommunityLegend.tsx — coverage tests
 *
 * @vitest-environment happy-dom
 *
 * Branches covered:
 * - communities: [] → returns null (nothing rendered)
 * - communities with label → label text displayed, title = "Community N"
 * - swatch uses provided color
 */

// @vitest-environment happy-dom

import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';

import { CommunityLegend } from '../../../../src/webview/components/reactflow/CommunityLegend';

describe('CommunityLegend', () => {
  it('renders nothing when communities is empty', () => {
    const { container } = render(
      React.createElement(CommunityLegend, { communities: [] })
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders a label with the hub node basename', () => {
    render(
      React.createElement(CommunityLegend, {
        communities: [{ id: 1, label: 'Spider.ts', color: '#4E79A7' }],
      })
    );
    expect(screen.getByText('Spider.ts')).toBeTruthy();
  });

  it('sets title="Cluster N — M clusters total" on the label span', () => {
    render(
      React.createElement(CommunityLegend, {
        communities: [{ id: 1, label: 'Spider.ts', color: '#4E79A7' }],
      })
    );
    const span = screen.getByTitle('Cluster 1 — 1 clusters total');
    expect(span).toBeTruthy();
    expect(span.textContent).toBe('Spider.ts');
  });

  it('renders correct swatch color from provided color prop', () => {
    render(
      React.createElement(CommunityLegend, {
        communities: [{ id: 2, label: 'index.ts', color: '#F28E2B' }],
      })
    );
    const swatch = screen.getByTestId('community-swatch-2') as HTMLElement;
    expect(swatch.style.background).toBe('#F28E2B');
  });

  it('renders multiple communities', () => {
    render(
      React.createElement(CommunityLegend, {
        communities: [
          { id: 1, label: 'Spider.ts', color: '#4E79A7' },
          { id: 2, label: 'Indexer.ts', color: '#F28E2B' },
          { id: 3, label: 'Query.ts', color: '#E15759' },
        ],
      })
    );
    expect(screen.getByTestId('community-swatch-1')).toBeTruthy();
    expect(screen.getByTestId('community-swatch-2')).toBeTruthy();
    expect(screen.getByTestId('community-swatch-3')).toBeTruthy();
    expect(screen.getByText('Spider.ts')).toBeTruthy();
    expect(screen.getByText('Indexer.ts')).toBeTruthy();
    expect(screen.getByText('Query.ts')).toBeTruthy();
  });

  it('renders "Import clusters" header', () => {
    render(
      React.createElement(CommunityLegend, {
        communities: [{ id: 1, label: 'Hub.ts', color: '#4E79A7' }],
      })
    );
    expect(screen.getByText('Import clusters')).toBeTruthy();
  });

  it('renders subtitle "Groups of closely connected files"', () => {
    render(
      React.createElement(CommunityLegend, {
        communities: [{ id: 1, label: 'Hub.ts', color: '#4E79A7' }],
      })
    );
    expect(screen.getByText('Groups of closely connected files')).toBeTruthy();
  });

  it('does not self-position — positioning is owned by the wrapper in ReactFlowGraph (GH #122)', () => {
    const { container } = render(
      React.createElement(CommunityLegend, {
        communities: [{ id: 1, label: 'Hub.ts', color: '#4E79A7' }],
      })
    );
    const root = container.firstChild as HTMLElement;
    expect(root.style.position).toBe('');
    expect(root.style.right).toBe('');
    expect(root.style.left).toBe('');
    expect(root.style.bottom).toBe('');
  });

  it('title includes total cluster count for multiple communities', () => {
    render(
      React.createElement(CommunityLegend, {
        communities: [
          { id: 1, label: 'A.ts', color: '#4E79A7' },
          { id: 2, label: 'B.ts', color: '#F28E2B' },
        ],
      })
    );
    const span1 = screen.getByTitle('Cluster 1 — 2 clusters total');
    const span2 = screen.getByTitle('Cluster 2 — 2 clusters total');
    expect(span1.textContent).toBe('A.ts');
    expect(span2.textContent).toBe('B.ts');
  });
});
