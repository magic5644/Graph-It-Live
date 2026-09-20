import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { BranchWatchAnalyzer, type BranchWatchResult, type BranchWatchSnapshot } from '@/analyzer/BranchWatchAnalyzer';
import { isPathWithinRoot } from '@/shared/pathSecurity';
import { normalizePathForComparison } from '@/shared/path';
import { validateReviewCallGraphTarget } from '@/shared/reviewTarget';
import type { GraphProvider } from '../GraphProvider';
import { BranchWatchTreeProvider, branchWatchStatus, type BranchWatchItem } from './BranchWatchTreeProvider';

export type BranchWatchPhase = 'disabled' | 'paused' | 'dirty' | 'pending' | 'running' | 'ready' | 'unavailable';
export interface BranchWatchViewState {
  phase: BranchWatchPhase;
  result?: BranchWatchResult;
  reason?: string;
}
interface BranchWatchOptions {
  analyzer: Pick<BranchWatchAnalyzer, 'capture' | 'analyze'>;
  prepareIndex: (snapshot: BranchWatchSnapshot) => Promise<void>;
  isDirty: () => boolean;
  onActiveChange?: (active: boolean) => void;
}

/** One debounced review at a time. Every asynchronous result belongs to one generation. */
export class BranchWatchService implements vscode.Disposable {
  state: BranchWatchViewState = { phase: 'disabled' };
  private readonly listeners = new Set<(state: BranchWatchViewState) => void>();
  private enabled = false;
  private paused = false;
  private disposed = false;
  private reference = '';
  private headReference = '';
  private generation = 0;
  private inFlight = false;
  private pending = false;
  private pendingSince?: number;
  private force = false;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private readonly options: BranchWatchOptions) {}

  readonly onDidChangeState = (listener: (state: BranchWatchViewState) => void): vscode.Disposable => {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  };

  configure(enabled: boolean, reference: string, headReference = ''): void {
    if (this.enabled === enabled && this.reference === reference && this.headReference === headReference
      && this.state.phase !== 'disabled' && this.state.phase !== 'unavailable') return;
    this.invalidate();
    this.enabled = enabled;
    this.reference = reference;
    this.headReference = headReference;
    this.paused = false;
    this.options.onActiveChange?.(enabled && Boolean(reference));
    if (!enabled) this.publish({ phase: 'disabled' });
    else if (!reference) this.publish({ phase: 'unavailable', reason: 'Select a base reference.' });
    else this.refresh(true);
  }

  unavailable(reason: string): void {
    this.invalidate();
    this.options.onActiveChange?.(false);
    this.publish({ ...this.state, phase: 'unavailable', reason });
  }

  pause(): void {
    if (!this.enabled || this.disposed) return;
    this.paused = true;
    this.invalidate();
    this.options.onActiveChange?.(false);
    this.publish({ ...this.state, phase: 'paused', reason: 'Paused; previous results are historical.' });
  }

  resume(): void {
    if (!this.enabled || this.disposed) return;
    this.paused = false;
    this.options.onActiveChange?.(true);
    this.refresh(true);
  }

  markDirty(): void {
    if (!this.active()) return;
    this.invalidate();
    this.publish({ ...this.state, phase: 'dirty', reason: 'Save required; previous results describe saved files only.' });
  }

  refresh(force = false): void {
    if (!this.active()) return;
    this.generation++;
    this.force ||= force;
    if (this.options.isDirty()) { this.markDirty(); return; }
    this.pending = true;
    this.pendingSince ??= Date.now();
    const delay = Math.max(0, 1000 - (Date.now() - this.pendingSince));
    if (!this.inFlight) this.publish({ ...this.state, phase: 'pending', reason: 'Waiting for file events to settle (max 1s); previous results are stale.' });
    // Keep the first deadline; recreating the timer for every filesystem event
    // can starve analysis indefinitely on a busy workspace.
    if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; void this.run(); }, delay);
  }

  dispose(): void {
    this.disposed = true;
    this.invalidate();
    this.options.onActiveChange?.(false);
    this.state = { phase: 'disabled' };
    this.listeners.clear();
  }

  private active(): boolean { return this.enabled && !this.paused && !this.disposed && Boolean(this.reference); }
  private invalidate(): void {
    this.generation++;
    this.pending = false;
    this.pendingSince = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
  private publish(state: BranchWatchViewState): void {
    if (this.disposed) return;
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }

  private async run(): Promise<void> {
    if (!this.active() || this.inFlight || !this.pending) return;
    this.pending = false;
    this.pendingSince = undefined;
    this.inFlight = true;
    const generation = this.generation;
    const forced = this.force;
    this.force = false;
    this.publish({ ...this.state, phase: 'running', reason: 'Analyzing saved changes; previous results are stale.' });
    try {
      await this.analyzeGeneration(generation, forced);
    } catch (error) {
      if (this.isCurrent(generation)) {
        this.publish({ ...this.state, phase: 'unavailable', reason: error instanceof Error ? error.message : 'Branch watch unavailable.' });
      }
    } finally {
      this.inFlight = false;
      if (this.pending && this.active() && !this.timer) this.refresh();
    }
  }

  private isCurrent(generation: number): boolean {
    return this.active() && generation === this.generation && !this.options.isDirty();
  }

  private async analyzeGeneration(generation: number, forced: boolean): Promise<void> {
    const before = await this.options.analyzer.capture(this.reference, this.headReference || undefined);
    if (!this.isCurrent(generation)) return;
    if (!forced && this.state.result?.snapshot.fingerprint === before.fingerprint) {
      this.publish({ phase: 'ready', result: this.state.result });
      return;
    }
    // A complete revert produces an empty delta. There is no dependency impact
    // to resolve, so rebuilding or waiting for the reverse index only delays
    // publishing the cleared result.
    if (before.changes.length > 0) await this.options.prepareIndex(before);
    if (!this.isCurrent(generation)) return;
    const result = await this.options.analyzer.analyze(before);
    if (!this.isCurrent(generation)) return;
    const after = await this.options.analyzer.capture(this.reference, this.headReference || undefined);
    if (!this.isCurrent(generation)) return;
    if (before.fingerprint !== after.fingerprint) { this.refresh(); return; }
    this.publish({ phase: 'ready', result });
  }
}

interface GitRepository {
  rootUri: vscode.Uri;
  state: { onDidChange: vscode.Event<void> };
}
interface GitApi {
  getRepository: (uri: vscode.Uri) => GitRepository | null;
  openRepository?: (uri: vscode.Uri) => Promise<GitRepository | null>;
  onDidCloseRepository: vscode.Event<GitRepository>;
}

interface BranchWatchPreferences {
  baseRef: string;
  headRef: string;
}

async function readBranchWatchPreferences(root: string, fallback: BranchWatchPreferences): Promise<BranchWatchPreferences> {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(root, '.graph-it', 'branch-watch.json'), 'utf8')) as Partial<BranchWatchPreferences>;
    return { baseRef: typeof raw.baseRef === 'string' ? raw.baseRef : fallback.baseRef,
      headRef: typeof raw.headRef === 'string' ? raw.headRef : fallback.headRef };
  } catch {
    return fallback;
  }
}

async function writeBranchWatchPreferences(root: string, preferences: BranchWatchPreferences): Promise<void> {
  const directory = path.join(root, '.graph-it');
  await fs.mkdir(directory, { recursive: true });
  const target = path.join(directory, 'branch-watch.json');
  const temporary = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(preferences, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, target);
}

async function gitRepository(root: string): Promise<{ api: GitApi; repository: GitRepository }> {
  const extension = vscode.extensions.getExtension<{ getAPI?: (version: number) => unknown }>('vscode.git');
  if (!extension) throw new Error('The VS Code Git API is unavailable. Enable the built-in Git extension and retry.');
  const exports = extension.isActive ? extension.exports : await extension.activate();
  if (typeof exports?.getAPI !== 'function') throw new Error('The Git extension does not expose API version 1.');
  const candidate = exports.getAPI(1) as Partial<GitApi> | undefined;
  if (typeof candidate?.getRepository !== 'function' || typeof candidate.onDidCloseRepository !== 'function') {
    throw new TypeError('The Git API is incompatible with branch watch.');
  }
  const uri = vscode.Uri.file(root);
  const repository = candidate.getRepository(uri) ?? await candidate.openRepository?.(uri);
  if (typeof repository?.state?.onDidChange !== 'function' || typeof repository.rootUri?.fsPath !== 'string'
    || normalizePathForComparison(repository.rootUri.fsPath) !== normalizePathForComparison(root)) {
    throw new Error('The Git repository must match the active graph workspace. Reload the window and retry.');
  }
  return { api: candidate as GitApi, repository };
}

/** Native UI wiring is kept here; CLI and MCP never import this service. */
export function registerBranchWatch(context: vscode.ExtensionContext, provider: GraphProvider): vscode.Disposable {
  const spider = provider.getSpiderForLmTools();
  const root = spider?.workspaceRoot;
  const analyzer = root ? new BranchWatchAnalyzer(root, spider, context.extensionPath) : undefined;
  const tree = new BranchWatchTreeProvider(root ?? '(no workspace)');
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
  status.name = 'Graph-It-Live Branch Watch';
  status.command = 'graph-it-live.branchWatch.reveal';
  let enabled = false;
  let available = false;
  let disposed = false;
  let setupGeneration = 0;
  let git: Awaited<ReturnType<typeof gitRepository>> | undefined;
  let working: vscode.Disposable[] = [];
  const ignoredDirectories = new Set(['.git', 'node_modules', 'dist', 'build', 'out', 'coverage', '.vscode-test']);
  const relevant = (uri: vscode.Uri) => {
    if (uri.scheme !== 'file' || !root || !isPathWithinRoot(uri.fsPath, root)) return false;
    const segments = path.relative(root, uri.fsPath).split(path.sep);
    return !segments.some(segment => ignoredDirectories.has(segment));
  };
  const stopWorking = () => { working.splice(0).forEach(item => item.dispose()); };
  const service = new BranchWatchService({
    analyzer: analyzer ?? { capture: async () => { throw new Error('No graph workspace is open.'); }, analyze: async () => { throw new Error('No graph workspace is open.'); } },
    prepareIndex: snapshot => provider.prepareBranchWatchIndex(snapshot),
    isDirty: () => vscode.workspace.textDocuments.some(document => document.isDirty && relevant(document.uri)),
    onActiveChange: active => {
      stopWorking();
      if (!active || !git || !root) return;
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '**/*'));
      const changed = (uri: vscode.Uri) => { if (relevant(uri)) service.refresh(); };
      working = [watcher, watcher.onDidCreate(changed), watcher.onDidChange(changed), watcher.onDidDelete(changed),
        git.repository.state.onDidChange(() => service.refresh()),
        git.api.onDidCloseRepository(repository => { if (repository === git?.repository) service.unavailable('The Git repository was closed. Retry branch detection.'); }),
        vscode.workspace.onDidSaveTextDocument(document => changed(document.uri)),
        vscode.workspace.onDidChangeTextDocument(event => {
          if (!event.contentChanges.length || !relevant(event.document.uri)) return;
          // SCM discard/revert also emits a text-document change, but leaves
          // the document clean. Treat that as a real workspace change so the
          // cleared delta is published without requiring another save.
          if (event.document.isDirty) service.markDirty();
          else changed(event.document.uri);
        }),
        vscode.workspace.onDidCloseTextDocument(document => changed(document.uri)),
      ];
    },
  });
  const config = () => vscode.workspace.getConfiguration('graph-it-live', root ? vscode.Uri.file(root) : undefined);
  let preferences: BranchWatchPreferences = { baseRef: '', headRef: '' };
  let preferencesLoaded: Promise<void> | undefined;
  const loadPreferences = async () => {
    preferencesLoaded ??= readBranchWatchPreferences(root ?? '', {
      baseRef: config().get<string>('branchWatch.baseRef', ''),
      headRef: config().get<string>('branchWatch.headRef', ''),
    }).then(value => { preferences = value; });
    await preferencesLoaded;
  };
  const savePreferences = async (next: Partial<BranchWatchPreferences>) => {
    preferences = { ...preferences, ...next };
    await writeBranchWatchPreferences(root ?? '', preferences);
  };
  const sync = () => {
    tree.setState(service.state);
    const summary = branchWatchStatus(service.state);
    const base = visibleRef(preferences.baseRef);
    const head = visibleRef(preferences.headRef) || 'current branch';
    status.text = `$(git-branch) ${base} → ${head} · $(${summary.icon}) ${summary.text}`;
    status.tooltip = 'Structural analysis only. Tests must pass before delivery.';
    status.accessibilityInformation = { label: `Branch watch: ${summary.text}` };
    if (enabled && service.state.phase !== 'disabled') status.show(); else status.hide();
    void vscode.commands.executeCommand('setContext', 'graph-it-live.branchWatch.available', available);
    void vscode.commands.executeCommand('setContext', 'graph-it-live.branchWatch.enabled', enabled);
    void vscode.commands.executeCommand('setContext', 'graph-it-live.branchWatch.paused', service.state.phase === 'paused');
  };
  const configure = async () => {
    const generation = ++setupGeneration;
    enabled = config().get<boolean>('branchWatch.enabled', false);
    available = false;
    git = undefined;
    if (!enabled) {
      service.configure(false, '');
      sync();
      return;
    }
    try {
      if (!root || !analyzer || !vscode.workspace.workspaceFolders?.some(folder => isPathWithinRoot(root, folder.uri.fsPath))) {
        throw new Error('No matching graph workspace is open. Reload the window after selecting a repository root.');
      }
      if (!vscode.workspace.isTrusted) throw new Error('Workspace Trust is required for branch watch.');
      await analyzer.detectRepository();
      if (generation !== setupGeneration || disposed) return;
      available = true;
      if (enabled) {
        git = await gitRepository(root);
        if (generation !== setupGeneration || disposed) return;
      }
      await loadPreferences();
      service.configure(enabled, preferences.baseRef, preferences.headRef);
    } catch (error) {
      if (generation === setupGeneration && !disposed) service.unavailable(error instanceof Error ? error.message : 'Branch watch unavailable.');
    }
    if (generation === setupGeneration && !disposed) sync();
  };
  const selectBase = async () => {
    if (!available || !analyzer) return;
    const reference = await vscode.window.showQuickPick(await analyzer.listReferences(), { title: 'Branch watch: select a base branch', placeHolder: 'Local and remote-tracking branches; no fetch is performed.' });
    if (reference) {
      await savePreferences({ baseRef: reference });
      service.configure(enabled, preferences.baseRef, preferences.headRef);
      sync();
    }
  };
  const selectHead = async () => {
    if (!available || !analyzer) return;
    const references = ['(current branch)', ...(await analyzer.listReferences())];
    const selected = await vscode.window.showQuickPick(references, {
      title: 'Branch watch: select a head branch',
      placeHolder: 'Current branch includes saved workspace changes; another branch compares committed refs.',
    });
    if (selected) {
      await savePreferences({ headRef: selected === '(current branch)' ? '' : selected });
      service.configure(enabled, preferences.baseRef, preferences.headRef);
      sync();
    }
  };
  const openFile = async (target: unknown) => {
    const value = validateReviewCallGraphTarget(target);
    if (!analyzer) throw new Error('No graph workspace is open.');
    const absolute = await analyzer.resolveFile(value.file);
    await vscode.window.showTextDocument(vscode.Uri.file(absolute));
    return value;
  };
  const copyMessage = async (item: unknown) => {
    if (!item || typeof item !== 'object') return;
    const candidate = item as BranchWatchItem;
    const label = typeof candidate.label === 'string' ? candidate.label : candidate.label?.label;
    if (!label) return;
    await vscode.env.clipboard.writeText(`${label}${candidate.description ? ` · ${candidate.description}` : ''}`);
  };
  const copyStatus = async () => vscode.env.clipboard.writeText(tree.getCopyText());
  const command = (name: string, action: (...args: unknown[]) => unknown) => vscode.commands.registerCommand(`graph-it-live.branchWatch.${name}`, async (...args: unknown[]) => {
    try { return await action(...args); }
    catch (error) { service.unavailable(error instanceof Error ? error.message : 'Branch watch action failed.'); return undefined; }
  });
  const registrations = [
    vscode.window.registerTreeDataProvider('graph-it-live.branchWatchView', tree),
    service.onDidChangeState(sync),
    vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('graph-it-live.branchWatch')) void configure(); }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => { void configure(); }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => { void configure(); }),
    command('enable', async () => {
      if (!available) return;
      await loadPreferences();
      if (!preferences.baseRef) await selectBase();
      if (!preferences.baseRef) return;
      await config().update('branchWatch.enabled', true, vscode.ConfigurationTarget.WorkspaceFolder);
    }),
    command('disable', () => config().update('branchWatch.enabled', false, vscode.ConfigurationTarget.WorkspaceFolder)),
    command('pause', () => service.pause()), command('resume', () => service.resume()),
    command('refresh', async () => { if (service.state.phase === 'unavailable') await configure(); else service.refresh(true); }),
    command('retryDetection', configure), command('selectBase', selectBase), command('selectHead', selectHead),
    command('reveal', () => vscode.commands.executeCommand('graph-it-live.branchWatchView.focus')),
    command('openSettings', () => vscode.commands.executeCommand('workbench.action.openSettings', '@id:graph-it-live.branchWatch.enabled')),
    command('openFile', openFile),
    command('copyMessage', copyMessage),
    command('copyStatus', copyStatus),
    command('openCallGraph', async item => {
      const target = await openFile(item);
      // Keep the initial graph readable; the slider can expand it to depth 5.
      await vscode.commands.executeCommand('graph-it-live.reviewCallGraph', { ...target, depth: 1 });
    }),
    command('openCycle', async item => { await openFile(item); await vscode.commands.executeCommand('graph-it-live.showGraph'); }),
  ];
  if (context.extensionMode === vscode.ExtensionMode.Test) {
    registrations.push(vscode.commands.registerCommand('graph-it-live.branchWatch.testSnapshot', () => ({
      state: structuredClone(service.state), items: tree.getChildren().map(serializeItem), enabled, available,
      status: { text: status.text, visible: enabled && service.state.phase !== 'disabled' }, root,
    })));
  }
  void configure();
  return { dispose: () => { disposed = true; setupGeneration++; service.dispose(); stopWorking(); registrations.forEach(item => item.dispose()); status.dispose(); tree.dispose(); } };
}

function visibleRef(reference: string): string {
  return Array.from(reference, character => {
    const code = character.codePointAt(0) ?? 32;
    return code < 32 || code === 127 ? ' ' : character;
  }).join('') || 'Select base';
}
function serializeItem(item: BranchWatchItem): unknown {
  return { label: item.label, description: item.description, command: item.command, file: item.file,
    contextValue: item.contextValue, children: item.children?.map(serializeItem) };
}
