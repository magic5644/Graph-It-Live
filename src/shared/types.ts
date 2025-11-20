import { Dependency } from '../analyzer/types';

export interface ShowGraphMessage {
  command: 'updateGraph';
  filePath: string;
  dependencies: Dependency[];
}

export interface OpenFileMessage {
  command: 'openFile';
  path: string;
}

export type ExtensionToWebviewMessage = ShowGraphMessage;
export type WebviewToExtensionMessage = OpenFileMessage;
