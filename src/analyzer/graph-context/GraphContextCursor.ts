import { createHash } from 'node:crypto';
import { normalizePath } from '@/shared/path';
import type {
  GraphContextMode,
  GraphContextRequest,
  GraphContextSeed,
} from '@/shared/graph-context-types';

const CURSOR_FIELDS = ['revision', 'requestHash', 'offset', 'scope', 'mode'] as const;
const CURSOR_FIELD_SET = new Set<string>(CURSOR_FIELDS);
const MAX_CURSOR_LENGTH = 4_096;
const URL_SAFE_BASE64 = /^[A-Za-z0-9_-]+$/;
const GRAPH_CONTEXT_MODES = new Set<GraphContextMode>([
  'search',
  'neighbors',
  'path',
  'impact',
  'refactor',
  'overview',
]);

export interface GraphContextCursorPayload {
  revision: string;
  requestHash: string;
  offset: number;
  scope: string;
  mode: GraphContextMode;
}

export type GraphContextCursorBinding = Omit<GraphContextCursorPayload, 'offset'>;

/** Creates an opaque cursor containing only continuation binding metadata. */
export function createGraphContextCursor(payload: GraphContextCursorPayload): string {
  const validated = validateCursorPayload(payload);
  const cursor = Buffer.from(JSON.stringify(validated), 'utf8').toString('base64url');
  if (cursor.length > MAX_CURSOR_LENGTH) {
    throw new TypeError(`Graph context cursor cannot exceed ${MAX_CURSOR_LENGTH} characters.`);
  }
  return cursor;
}

/** Parses a cursor and optionally verifies that it belongs to the current request. */
export function parseGraphContextCursor(
  cursor: string,
  expected?: GraphContextCursorBinding,
): GraphContextCursorPayload {
  const payload = decodeCursor(cursor);
  if (expected !== undefined) validateCursorBinding(payload, expected);
  return payload;
}

/** Builds a stable request identity without storing request text in the cursor. */
export function createGraphContextRequestHash(
  request: GraphContextRequest,
  workspaceRoot: string,
): string {
  if (typeof workspaceRoot !== 'string' || workspaceRoot.trim().length === 0) {
    throw new TypeError('Workspace root must be a non-empty string.');
  }

  const canonicalRequest = {
    workspaceRoot: normalizeWorkspaceRoot(workspaceRoot),
    question: request.question ?? null,
    seeds: (request.seeds ?? []).map(canonicalizeSeed),
    mode: request.mode ?? 'search',
    from: request.from === undefined ? null : canonicalizeSeed(request.from),
    to: request.to === undefined ? null : canonicalizeSeed(request.to),
    relations: request.relations === undefined
      ? null
      : [...new Set(request.relations)].sort(),
    scope: normalizeScope(request.scope ?? '**'),
    depth: request.depth ?? null,
    maxNodes: request.maxNodes ?? null,
    tokenBudget: request.tokenBudget ?? null,
    directed: request.directed ?? null,
    format: request.format ?? null,
  };

  return createHash('sha256')
    .update(JSON.stringify(canonicalRequest), 'utf8')
    .digest('base64url');
}

function decodeCursor(cursor: string): GraphContextCursorPayload {
  if (
    typeof cursor !== 'string'
    || cursor.length === 0
    || cursor.length > MAX_CURSOR_LENGTH
    || !URL_SAFE_BASE64.test(cursor)
  ) {
    throw invalidCursorError();
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
  } catch {
    throw invalidCursorError();
  }

  try {
    return validateCursorPayload(decoded);
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Invalid graph context cursor: ${error.message}`, { cause: error });
    }
    throw invalidCursorError();
  }
}

function validateCursorPayload(value: unknown): GraphContextCursorPayload {
  if (!isRecord(value)) throw new TypeError('Cursor payload must be an object.');

  const fields = Object.keys(value);
  if (fields.length !== CURSOR_FIELDS.length || fields.some(field => !CURSOR_FIELD_SET.has(field))) {
    throw new TypeError('Cursor payload contains an unknown or missing field.');
  }
  if (!isNonEmptyString(value.revision)) {
    throw new TypeError('Cursor revision must be a non-empty string.');
  }
  if (!isNonEmptyString(value.requestHash)) {
    throw new TypeError('Cursor request hash must be a non-empty string.');
  }
  if (!Number.isSafeInteger(value.offset) || (value.offset as number) < 0) {
    throw new TypeError('Cursor offset must be a non-negative safe integer.');
  }
  if (typeof value.scope !== 'string') {
    throw new TypeError('Cursor scope must be a string.');
  }
  if (typeof value.mode !== 'string' || !GRAPH_CONTEXT_MODES.has(value.mode as GraphContextMode)) {
    throw new TypeError('Cursor mode is invalid.');
  }

  return {
    revision: value.revision,
    requestHash: value.requestHash,
    offset: value.offset as number,
    scope: normalizeScope(value.scope),
    mode: value.mode as GraphContextMode,
  };
}

function validateCursorBinding(
  payload: GraphContextCursorPayload,
  expected: GraphContextCursorBinding,
): void {
  if (!isNonEmptyString(expected.revision)) {
    throw new TypeError('Expected cursor revision must be a non-empty string.');
  }
  if (!isNonEmptyString(expected.requestHash)) {
    throw new TypeError('Expected cursor request hash must be a non-empty string.');
  }
  if (typeof expected.scope !== 'string') {
    throw new TypeError('Expected cursor scope must be a string.');
  }
  if (!GRAPH_CONTEXT_MODES.has(expected.mode)) {
    throw new TypeError('Expected cursor mode is invalid.');
  }

  if (payload.revision !== expected.revision) {
    throw new Error('Graph context cursor revision does not match the current index revision.');
  }
  if (payload.requestHash !== expected.requestHash) {
    throw new Error('Graph context cursor request does not match the current request.');
  }
  if (payload.scope !== normalizeScope(expected.scope)) {
    throw new Error('Graph context cursor scope does not match the current scope.');
  }
  if (payload.mode !== expected.mode) {
    throw new Error('Graph context cursor mode does not match the current mode.');
  }
}

function canonicalizeSeed(seed: GraphContextSeed): Record<string, string | null> {
  return {
    id: seed.id ?? null,
    filePath: seed.filePath === undefined ? null : normalizePath(seed.filePath),
    symbolName: seed.symbolName ?? null,
    label: seed.label ?? null,
  };
}

function normalizeWorkspaceRoot(workspaceRoot: string): string {
  const normalized = normalizePath(workspaceRoot).replace(/\/+$/, '');
  return normalized.length === 0 ? '/' : normalized;
}

function normalizeScope(scope: string): string {
  return normalizePath(scope);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function invalidCursorError(): Error {
  return new Error('Invalid graph context cursor.');
}
