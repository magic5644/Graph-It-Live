import type * as vscode from 'vscode';
import type { BranchWatchResult } from '@/analyzer/BranchWatchAnalyzer';

export type BranchWatchPhase = 'disabled' | 'paused' | 'dirty' | 'pending' | 'running' | 'ready' | 'unavailable';

export interface BranchWatchViewState {
  phase: BranchWatchPhase;
  result?: BranchWatchResult;
  reason?: string;
}

export interface BranchWatchRegistration extends vscode.Disposable {
  disposeAsync(): Promise<void>;
}
