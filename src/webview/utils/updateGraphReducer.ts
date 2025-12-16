import type { GraphData, ShowGraphMessage } from '../../shared/types';
import { normalizePath } from './path';
import { mergeGraphDataUnion } from './graphMerge';

export function applyUpdateGraph(
  current: GraphData | null,
  currentFilePath: string,
  message: Pick<ShowGraphMessage, 'filePath' | 'data' | 'isRefresh' | 'refreshReason'>
): GraphData {
  const isRefresh = Boolean(message.isRefresh);
  const sameFile = normalizePath(currentFilePath) === normalizePath(message.filePath);

  if (isRefresh && sameFile && current && message.refreshReason === 'indexing') {
    return mergeGraphDataUnion(current, message.data);
  }

  return message.data;
}

export function isUpdateGraphNavigation(currentFilePath: string, incomingFilePath: string): boolean {
  return normalizePath(currentFilePath) !== normalizePath(incomingFilePath);
}
