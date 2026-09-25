import * as vscode from 'vscode';
import type { BranchWatchResult } from '@/analyzer/BranchWatchAnalyzer';
import type { BranchWatchViewState } from './BranchWatchService';

export interface BranchWatchItem extends vscode.TreeItem {
  children?: BranchWatchItem[];
  file?: string;
  symbol?: string;
}
const visible = (text: string) => Array.from(text, character => {
  const code = character.codePointAt(0) ?? 32;
  return code < 32 || code === 127 ? ' ' : character;
}).join('');

export function branchWatchStatus(state: BranchWatchViewState): { text: string; icon: string } {
  switch (state.phase) {
    case 'disabled': return { text: 'Branch watch disabled', icon: 'git-branch' };
    case 'paused': return { text: 'Paused — historical results', icon: 'debug-pause' };
    case 'dirty': return { text: 'Save required', icon: 'edit' };
    case 'pending': return { text: 'Waiting for saved changes', icon: 'clock' };
    case 'running': return { text: 'Analyzing saved changes', icon: 'sync~spin' };
    case 'unavailable': return { text: 'Branch watch unavailable', icon: 'question' };
    case 'ready': {
      const result = state.result;
      if (!result) return { text: 'Branch watch unavailable', icon: 'question' };
      const count = result.limitations.length + result.cycles.length + result.review.symbols.filter(s => s.breakingChanges.length).length;
      const assessment = `risk ${result.review.risk} · confidence ${analysisConfidence(result)}`;
      if (count) return { text: `WARNING · ${count} checks · ${assessment}`, icon: 'warning' };
      return { text: result.snapshot.changes.length ? `Structure: OK · ${assessment}` : `No recorded changes · ${assessment}`, icon: 'check' };
    }
  }
}

type ConsumerCheck = { text: string; icon: string };

function analysisConfidence(result: BranchWatchResult): 'high' | 'medium' | 'low' {
  const changedPaths = new Set(result.snapshot.changes.map(change => change.path));
  const criticalGap = result.snapshot.changes.length > 0
    && (result.snapshot.readablePaths.length === 0
      || result.fileImpacts.some(impact => changedPaths.has(impact.path) && impact.availability === 'unavailable'));
  if (criticalGap) return 'low';
  if (result.review.isPartial || result.limitations.length > 0) return 'medium';
  return 'high';
}

function consumerCheck(result: BranchWatchResult, filePath: string): ConsumerCheck {
  const standing = result.review.symbols
    .map(symbol => symbol.consumers)
    .find(consumers => consumers.unverified.includes(filePath)
      || consumers.updated.includes(filePath)
      || consumers.covered.includes(filePath));
  if (standing?.unverified.includes(filePath)) return { text: 'manual check required', icon: 'warning' };
  if (standing?.updated.includes(filePath)) return { text: 'changed in diff · verify compatibility', icon: 'edit' };
  if (standing?.covered.includes(filePath)) return { text: 'test file detected · tests not run', icon: 'beaker' };
  return { text: 'no breaking contract detected · static analysis only', icon: 'info' };
}

/** Pure projection of the service model; never runs Git or analysis. */
export class BranchWatchTreeProvider implements vscode.TreeDataProvider<BranchWatchItem>, vscode.Disposable {
  private state: BranchWatchViewState = { phase: 'disabled' };
  private readonly changed = new vscode.EventEmitter<BranchWatchItem | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  constructor(private readonly root: string) {}
  setState(state: BranchWatchViewState): void { this.state = state; this.changed.fire(undefined); }
  getTreeItem(item: BranchWatchItem): vscode.TreeItem { return item; }
  dispose(): void { this.changed.dispose(); }

  getCopyText(): string {
    const label = (item: BranchWatchItem): string => {
      const value = typeof item.label === 'string' ? item.label : item.label?.label ?? '';
      return `${value}${item.description ? ` · ${item.description}` : ''}`;
    };
    const visit = (items: BranchWatchItem[], level: number): string[] => items.flatMap(item => [
      `${'  '.repeat(level)}${label(item)}`,
      ...visit(item.children ?? [], level + 1),
    ]);
    return visit(this.getChildren(), 0).join('\n');
  }

  getChildren(item?: BranchWatchItem): BranchWatchItem[] {
    if (item) return item.children ?? [];
    if (this.state.phase === 'disabled') return [];
    const status = branchWatchStatus(this.state);
    const result = this.state.result;
    const resultRows = result ? (() => {
      const snapshot = result.snapshot;
      return [
        this.row(`${snapshot.headReference ?? snapshot.branch} → ${snapshot.reference} · local references ${snapshot.headSha.slice(0, 12)} / ${snapshot.referenceSha.slice(0, 12)}`, 'git-branch'),
        this.row(`Merge-base: ${snapshot.mergeBaseSha.slice(0, 12)} · ${this.state.phase === 'ready' ? 'Updated' : 'Historical result from'} ${new Date(result.analyzedAt).toLocaleTimeString()}`),
        this.group('Changed files', result.fileImpacts.map(impact => {
        const file = this.file(impact.path);
        const kind = snapshot.changes.find(change => change.path === impact.path)?.kind;
        const signatureCount = result.review.symbols.filter(symbol => symbol.filePath === impact.path).length;
        file.description = `${kind ?? 'modified'} · ${impact.availability}${signatureCount ? ` · ${signatureCount} signature change${signatureCount === 1 ? '' : 's'}` : ''}`;
        file.children = [
          ...impact.dependents.map(dependent => {
            const check = consumerCheck(result, dependent.path);
            const item = this.file(dependent.path, `depth ${dependent.depth} · ${dependent.changed ? 'changed; compatibility unproven' : check.text}`);
            item.iconPath = new vscode.ThemeIcon(check.icon);
            return item;
          }),
        ];
        if (!file.children.length) file.children.push(this.row('No known importers of this file; this does not prove absence of impact.'));
        file.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
        if (kind === 'deleted') { file.command = undefined; file.contextValue = undefined; }
        return file;
        })),
        this.group('Consumers to review', result.review.symbols.map(symbol => {
        const file = this.file(symbol.filePath);
        file.label = visible(`${symbol.name}: ${symbol.breakingChanges.map(change => change.description).join('; ')}`);
        file.symbol = symbol.name;
        file.children = (result.fileImpacts.find(impact => impact.path === symbol.filePath)?.dependents ?? [])
          .map(consumer => {
            const check = consumerCheck(result, consumer.path);
            const item = this.file(consumer.path, consumer.changed ? 'changed; compatibility unproven' : check.text);
            item.iconPath = new vscode.ThemeIcon(consumer.changed ? 'edit' : check.icon);
            return item;
          });
        file.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
        return file;
        })),
        this.group('Cyclic dependencies', [
          ...(result.cycleSummary?.detected ? [this.row(`Affected dependency scope: ${result.cycleSummary.detected} cycle(s) detected`, 'warning')] : []),
          ...(result.cycleSummary && !result.cycleSummary.scopeComplete ? [this.row('Cycle count is partial because the affected dependency scope is incomplete.', 'warning')] : []),
          ...result.cycles.map(cycle => {
          const label = { introduced: 'New cycle introduced', aggravated: 'Existing cycle expanded', 'existing-touched': 'Existing cycle touched' }[cycle.classification];
        const row = this.group(`${label}: ${cycle.nodePaths.map(visible).join(' ↔ ')}`, [
          this.row(`File dependency cycle · baseline: ${cycle.classification === 'introduced' ? 'absent' : 'already present'}`),
          this.row('A design change or decomposition is probably required.'),
          ...cycle.nodePaths.map(file => this.file(file)),
        ]);
          row.file = cycle.nodePaths[0]; row.contextValue = 'branchWatchCycle'; row.iconPath = new vscode.ThemeIcon('warning');
          return row;
        }),
        ]),
        this.group('Limitations', [...new Set(result.limitations)].map(limit => this.row(limit, 'warning'))),
      ];
    })() : [];
    return [
      this.row(status.text, status.icon),
      ...(this.state.reason ? [this.row(this.state.reason)] : []),
      this.row(`Workspace: ${this.root}`, 'root-folder'),
      ...resultRows,
      this.group('Tests', [this.row('Tests must pass before delivery.', 'beaker')]),
    ];
  }

  private row(label: string, icon?: string): BranchWatchItem {
    const item: BranchWatchItem = new vscode.TreeItem(visible(label), vscode.TreeItemCollapsibleState.None);
    item.contextValue = 'branchWatchMessage';
    if (icon) item.iconPath = new vscode.ThemeIcon(icon);
    return item;
  }
  private group(label: string, children: BranchWatchItem[]): BranchWatchItem {
    const item = this.row(label);
    item.children = children;
    item.collapsibleState = children.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None;
    return item;
  }
  private file(file: string, description?: string): BranchWatchItem {
    const item = this.row(file, 'file-code');
    item.file = file;
    item.description = description;
    item.command = { command: 'graph-it-live.branchWatch.openFile', title: 'Open file', arguments: [{ file }] };
    if (/\.(ts|tsx|js|jsx|mjs|cjs|py|rs|cs|go|java|vue|svelte)$/i.test(file)) item.contextValue = 'branchWatchFile';
    return item;
  }
}
