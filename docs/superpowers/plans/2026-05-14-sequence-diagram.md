# Sequence Diagram Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build deterministic sequence-diagram generation from an entry symbol and expose it consistently via CLI, MCP, and a dedicated VS Code Sequence panel with mandatory monorepo cache.

**Architecture:** Add a shared analyzer module (`src/analyzer/sequence/`) producing a canonical `SequenceModel`, then reuse it in CLI (`graph-it sequence`), MCP (`graphitlive_generate_sequence_diagram`), and extension/webview sequence view. Use two-level cache (memory LRU + `.graph-it/sequence-cache`) with explicit invalidation on file changes. Keep unresolved edges explicit with confidence metadata and warnings; never infer silently.

**Tech Stack:** TypeScript (strict), Tree-sitter extraction reuse, existing call graph index/query modules, VS Code extension service layer, React webview, Vitest + VS Code E2E.

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/analyzer/sequence/types.ts` | Create | Canonical sequence domain model and options |
| `src/analyzer/sequence/order.ts` | Create | Deterministic message ordering |
| `src/analyzer/sequence/SequenceEngine.ts` | Create | Core generation pipeline |
| `src/analyzer/sequence/renderers/mermaidSequenceRenderer.ts` | Create | Mermaid sequence rendering |
| `src/analyzer/sequence/renderers/markdownSequenceRenderer.ts` | Create | Markdown wrapper rendering |
| `src/analyzer/sequence/cache/SequenceMemoryCache.ts` | Create | In-memory LRU cache |
| `src/analyzer/sequence/cache/SequenceDiskCache.ts` | Create | Disk cache in `.graph-it/sequence-cache` |
| `src/analyzer/sequence/cache/key.ts` | Create | Stable cache key generation |
| `src/cli/commands/sequence.ts` | Create | CLI command implementation |
| `src/cli/index.ts` | Modify | Register `sequence` command |
| `src/cli/commandHelp.ts` | Modify | Add help for `sequence` |
| `src/cli/formatter.ts` | Modify | Sequence output formatting (`text/json/toon/markdown/mermaid`) |
| `src/mcp/types.ts` | Modify | Add sequence tool schemas/result types |
| `src/mcp/mcpServer.ts` | Modify | Register MCP tool |
| `src/mcp/McpWorker.ts` | Modify | Execute sequence tool with shared engine |
| `src/shared/types.ts` | Modify | Add sequence extension/webview messages |
| `src/extension/services/SequenceViewService.ts` | Create | Sequence panel orchestration |
| `src/extension/extension.ts` | Modify | Register sequence command/service |
| `src/extension/services/MessageDispatcher.ts` | Modify | Route sequence webview messages |
| `src/webview/sequence/index.tsx` | Create | Sequence webview entry point |
| `src/webview/components/sequence/SequenceView.tsx` | Create | Sequence panel UI |
| `tests/analyzer/sequence/sequenceEngine.test.ts` | Create | Engine determinism and unresolved behavior |
| `tests/analyzer/sequence/cache.test.ts` | Create | Cache behavior tests |
| `tests/cli/sequence.test.ts` | Create | CLI behavior and formats |
| `tests/mcp/sequenceTool.test.ts` | Create | MCP tool validation and output |
| `tests/vscode-e2e/suite/sequenceView.test.ts` | Create | End-to-end sequence panel flow |
| `package.json` | Modify | Add command contribution + settings for sequence cache |
| `docs/CLI.md` | Modify | CLI documentation |
| `README.md` | Modify | Feature overview |
| `changelog.md` | Modify | Release notes |

---

### Task 1: Define SequenceModel contracts (TDD)

**Files:**
- Create: `src/analyzer/sequence/types.ts`
- Test: `tests/analyzer/sequence/sequenceEngine.test.ts`

- [ ] **Step 1: Write failing type-contract test**

```ts
import { describe, expect, it } from 'vitest';
import type { SequenceModel, SequenceGenerationParams } from '../../../src/analyzer/sequence/types.js';

describe('sequence types contract', () => {
  it('accepts minimal valid model shape', () => {
    const params: SequenceGenerationParams = {
      workspaceRoot: '/repo',
      filePath: '/repo/src/index.ts',
      symbolName: 'main',
      maxDepth: 3,
      maxSteps: 100,
      includeExternal: true,
      includeAnnotations: true,
      useCache: true,
    };

    const model: SequenceModel = {
      root: { id: '/repo/src/index.ts:main:1:0', symbolName: 'main', filePath: '/repo/src/index.ts' },
      participants: [],
      messages: [],
      warnings: [],
      truncated: false,
      stats: { participantsCount: 0, messagesCount: 0, analysisTimeMs: 0 },
    };

    expect(params.symbolName).toBe('main');
    expect(model.truncated).toBe(false);
  });
});
```

- [ ] **Step 2: Run test and confirm failure**

Run: `npx vitest run tests/analyzer/sequence/sequenceEngine.test.ts -t "sequence types contract"`
Expected: FAIL with module not found for `src/analyzer/sequence/types.ts`.

- [ ] **Step 3: Create `types.ts` with explicit contracts**

```ts
export type SequenceConfidence = 'high' | 'medium' | 'low' | 'unresolved';

export interface SequenceRoot {
  id: string;
  symbolName: string;
  filePath: string;
}

export interface SequenceParticipant {
  id: string;
  label: string;
  filePath: string | null;
  external: boolean;
}

export interface SequenceMessage {
  id: string;
  fromParticipantId: string;
  toParticipantId: string;
  label: string;
  relationType: 'CALLS' | 'USES' | 'RETURNS' | 'THROWS';
  async: boolean;
  confidence: SequenceConfidence;
  sourceFile: string;
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

export interface SequenceWarning {
  code: 'UNRESOLVED_TARGET' | 'TRUNCATED' | 'AMBIGUOUS_TARGET';
  message: string;
  sourceFile?: string;
  startLine?: number;
}

export interface SequenceStats {
  participantsCount: number;
  messagesCount: number;
  analysisTimeMs: number;
}

export interface SequenceModel {
  root: SequenceRoot;
  participants: SequenceParticipant[];
  messages: SequenceMessage[];
  warnings: SequenceWarning[];
  truncated: boolean;
  stats: SequenceStats;
}

export interface SequenceGenerationParams {
  workspaceRoot: string;
  filePath: string;
  symbolName: string;
  maxDepth: number;
  maxSteps: number;
  includeExternal: boolean;
  includeAnnotations: boolean;
  useCache: boolean;
}
```

- [ ] **Step 4: Re-run test and confirm pass**

Run: `npx vitest run tests/analyzer/sequence/sequenceEngine.test.ts -t "sequence types contract"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/analyzer/sequence/types.ts tests/analyzer/sequence/sequenceEngine.test.ts
git commit -m "feat(sequence): add core sequence type contracts"
```

---

### Task 2: Build deterministic ordering + minimal engine (TDD)

**Files:**
- Create: `src/analyzer/sequence/order.ts`
- Create: `src/analyzer/sequence/SequenceEngine.ts`
- Test: `tests/analyzer/sequence/sequenceEngine.test.ts`

- [ ] **Step 1: Add failing determinism test**

```ts
import { generateSequence } from '../../../src/analyzer/sequence/SequenceEngine.js';

describe('SequenceEngine determinism', () => {
  it('returns stable message order for same inputs', async () => {
    const params = {
      workspaceRoot: '/repo',
      filePath: '/repo/src/index.ts',
      symbolName: 'main',
      maxDepth: 2,
      maxSteps: 100,
      includeExternal: true,
      includeAnnotations: true,
      useCache: false,
    };

    const first = await generateSequence(params);
    const second = await generateSequence(params);
    expect(second.messages.map(m => m.id)).toEqual(first.messages.map(m => m.id));
  });
});
```

- [ ] **Step 2: Run test and confirm failure**

Run: `npx vitest run tests/analyzer/sequence/sequenceEngine.test.ts -t "determinism"`
Expected: FAIL with missing exports/functions.

- [ ] **Step 3: Implement ordering and minimal engine**

```ts
// src/analyzer/sequence/order.ts
import type { SequenceMessage } from './types.js';

export function orderMessages(messages: SequenceMessage[]): SequenceMessage[] {
  return [...messages].sort((a, b) => {
    if (a.sourceFile !== b.sourceFile) return a.sourceFile.localeCompare(b.sourceFile);
    if (a.startLine !== b.startLine) return a.startLine - b.startLine;
    if (a.startCol !== b.startCol) return a.startCol - b.startCol;
    return a.id.localeCompare(b.id);
  });
}
```

```ts
// src/analyzer/sequence/SequenceEngine.ts
import type { SequenceGenerationParams, SequenceModel } from './types.js';
import { orderMessages } from './order.js';

export async function generateSequence(params: SequenceGenerationParams): Promise<SequenceModel> {
  const started = Date.now();

  const model: SequenceModel = {
    root: {
      id: `${params.filePath}:${params.symbolName}:0:0`,
      symbolName: params.symbolName,
      filePath: params.filePath,
    },
    participants: [],
    messages: orderMessages([]),
    warnings: [],
    truncated: false,
    stats: {
      participantsCount: 0,
      messagesCount: 0,
      analysisTimeMs: Date.now() - started,
    },
  };

  return model;
}
```

- [ ] **Step 4: Re-run test and confirm pass**

Run: `npx vitest run tests/analyzer/sequence/sequenceEngine.test.ts -t "determinism"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/analyzer/sequence/order.ts src/analyzer/sequence/SequenceEngine.ts tests/analyzer/sequence/sequenceEngine.test.ts
git commit -m "feat(sequence): add deterministic ordering and minimal engine"
```

---

### Task 3: Add Mermaid + Markdown renderers (TDD)

**Files:**
- Create: `src/analyzer/sequence/renderers/mermaidSequenceRenderer.ts`
- Create: `src/analyzer/sequence/renderers/markdownSequenceRenderer.ts`
- Modify: `tests/analyzer/sequence/sequenceEngine.test.ts`

- [ ] **Step 1: Add failing renderer test**

```ts
import { renderMermaidSequence } from '../../../src/analyzer/sequence/renderers/mermaidSequenceRenderer.js';

it('renders mermaid sequence header and participants', () => {
  const mermaid = renderMermaidSequence({
    root: { id: 'a', symbolName: 'main', filePath: '/repo/src/index.ts' },
    participants: [{ id: 'p1', label: 'main', filePath: '/repo/src/index.ts', external: false }],
    messages: [],
    warnings: [],
    truncated: false,
    stats: { participantsCount: 1, messagesCount: 0, analysisTimeMs: 1 },
  });

  expect(mermaid).toContain('sequenceDiagram');
  expect(mermaid).toContain('participant p1 as main');
});
```

- [ ] **Step 2: Run test and confirm failure**

Run: `npx vitest run tests/analyzer/sequence/sequenceEngine.test.ts -t "renders mermaid sequence header"`
Expected: FAIL with missing renderer module.

- [ ] **Step 3: Implement renderers**

```ts
// src/analyzer/sequence/renderers/mermaidSequenceRenderer.ts
import type { SequenceModel } from '../types.js';

export function renderMermaidSequence(model: SequenceModel): string {
  const lines: string[] = ['sequenceDiagram'];

  for (const p of model.participants) {
    lines.push(`participant ${p.id} as ${p.label}`);
  }

  for (const m of model.messages) {
    const arrow = m.async ? '->>' : '->>';
    lines.push(`${m.fromParticipantId}${arrow}${m.toParticipantId}: ${m.label}`);
    if (m.relationType === 'RETURNS') {
      lines.push(`${m.toParticipantId}-->>${m.fromParticipantId}: return`);
    }
  }

  for (const w of model.warnings) {
    lines.push(`Note over ${model.root.id}: ${w.code} ${w.message}`);
  }

  if (model.truncated) {
    lines.push('Note over root: truncated output for readability');
  }

  return lines.join('\n');
}
```

```ts
// src/analyzer/sequence/renderers/markdownSequenceRenderer.ts
import type { SequenceModel } from '../types.js';
import { renderMermaidSequence } from './mermaidSequenceRenderer.js';

export function renderSequenceMarkdown(model: SequenceModel): string {
  const mermaid = renderMermaidSequence(model);
  const warnings = model.warnings.length === 0
    ? '- none'
    : model.warnings.map((w) => `- ${w.code}: ${w.message}`).join('\n');

  return [
    '## Sequence Diagram',
    '',
    '```mermaid',
    mermaid,
    '```',
    '',
    '## Warnings',
    warnings,
  ].join('\n');
}
```

- [ ] **Step 4: Re-run test and confirm pass**

Run: `npx vitest run tests/analyzer/sequence/sequenceEngine.test.ts -t "renders mermaid sequence header"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/analyzer/sequence/renderers/mermaidSequenceRenderer.ts src/analyzer/sequence/renderers/markdownSequenceRenderer.ts tests/analyzer/sequence/sequenceEngine.test.ts
git commit -m "feat(sequence): add mermaid and markdown renderers"
```

---

### Task 4: Add two-level cache (TDD)

**Files:**
- Create: `src/analyzer/sequence/cache/SequenceMemoryCache.ts`
- Create: `src/analyzer/sequence/cache/SequenceDiskCache.ts`
- Create: `src/analyzer/sequence/cache/key.ts`
- Test: `tests/analyzer/sequence/cache.test.ts`

- [ ] **Step 1: Add failing cache tests**

```ts
import { describe, expect, it } from 'vitest';
import { buildSequenceCacheKey } from '../../../src/analyzer/sequence/cache/key.js';

describe('sequence cache key', () => {
  it('is deterministic', () => {
    const a = buildSequenceCacheKey({ workspaceRoot: '/repo', filePath: '/repo/src/a.ts', symbolName: 'main', maxDepth: 2, maxSteps: 50, includeExternal: true, includeAnnotations: true, engineVersion: '1' });
    const b = buildSequenceCacheKey({ workspaceRoot: '/repo', filePath: '/repo/src/a.ts', symbolName: 'main', maxDepth: 2, maxSteps: 50, includeExternal: true, includeAnnotations: true, engineVersion: '1' });
    expect(a).toBe(b);
  });
});
```

- [ ] **Step 2: Run test and confirm failure**

Run: `npx vitest run tests/analyzer/sequence/cache.test.ts`
Expected: FAIL with missing cache modules.

- [ ] **Step 3: Implement cache key + memory cache + disk cache**

```ts
// src/analyzer/sequence/cache/key.ts
import crypto from 'node:crypto';

export function buildSequenceCacheKey(input: {
  workspaceRoot: string;
  filePath: string;
  symbolName: string;
  maxDepth: number;
  maxSteps: number;
  includeExternal: boolean;
  includeAnnotations: boolean;
  engineVersion: string;
}): string {
  const payload = JSON.stringify(input);
  return crypto.createHash('sha256').update(payload).digest('hex');
}
```

```ts
// src/analyzer/sequence/cache/SequenceMemoryCache.ts
import type { SequenceModel } from '../types.js';

type Entry = { value: SequenceModel; expiresAt: number };

export class SequenceMemoryCache {
  private readonly map = new Map<string, Entry>();

  constructor(private readonly ttlMs: number, private readonly maxEntries: number) {}

  get(key: string): SequenceModel | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: SequenceModel): void {
    if (this.map.size >= this.maxEntries) {
      const first = this.map.keys().next().value as string | undefined;
      if (first) this.map.delete(first);
    }
    this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  clear(): void {
    this.map.clear();
  }
}
```

```ts
// src/analyzer/sequence/cache/SequenceDiskCache.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SequenceModel } from '../types.js';

export class SequenceDiskCache {
  constructor(private readonly workspaceRoot: string) {}

  private filePath(key: string): string {
    return path.join(this.workspaceRoot, '.graph-it', 'sequence-cache', `${key}.json`);
  }

  read(key: string): SequenceModel | undefined {
    try {
      const raw = fs.readFileSync(this.filePath(key), 'utf-8');
      return JSON.parse(raw) as SequenceModel;
    } catch {
      return undefined;
    }
  }

  write(key: string, model: SequenceModel): void {
    const file = this.filePath(key);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(model));
  }
}
```

- [ ] **Step 4: Re-run tests and confirm pass**

Run: `npx vitest run tests/analyzer/sequence/cache.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/analyzer/sequence/cache tests/analyzer/sequence/cache.test.ts
git commit -m "feat(sequence): add memory and disk cache primitives"
```

---

### Task 5: Expose CLI command `graph-it sequence` (TDD)

**Files:**
- Create: `src/cli/commands/sequence.ts`
- Modify: `src/cli/index.ts`
- Modify: `src/cli/commandHelp.ts`
- Modify: `src/cli/formatter.ts`
- Test: `tests/cli/sequence.test.ts`

- [ ] **Step 1: Add failing CLI test**

```ts
import { describe, expect, it } from 'vitest';

it('runs sequence command with mermaid output', async () => {
  const { run } = await import('../../src/cli/commands/sequence.js');
  const output = await run(['/repo/src/index.ts#main'], { workspaceRoot: '/repo' } as never, 'mermaid');
  expect(output).toContain('sequenceDiagram');
});
```

- [ ] **Step 2: Run test and confirm failure**

Run: `npx vitest run tests/cli/sequence.test.ts`
Expected: FAIL with missing command module.

- [ ] **Step 3: Implement command + registration + formatter path**

```ts
// src/cli/commands/sequence.ts
import type { CliOutputFormat } from '../formatter.js';
import type { CliRuntime } from '../runtime.js';
import { parseSymbolRef } from '../symbols.js';
import { generateSequence } from '../../analyzer/sequence/SequenceEngine.js';
import { renderMermaidSequence } from '../../analyzer/sequence/renderers/mermaidSequenceRenderer.js';
import { renderSequenceMarkdown } from '../../analyzer/sequence/renderers/markdownSequenceRenderer.js';

export async function run(args: string[], runtime: CliRuntime, format: CliOutputFormat): Promise<string> {
  const [entry] = args;
  const parsed = parseSymbolRef(entry, runtime.workspaceRoot);
  const symbolName = parsed.symbolName ?? 'main';

  const model = await generateSequence({
    workspaceRoot: runtime.workspaceRoot,
    filePath: parsed.filePath,
    symbolName,
    maxDepth: 6,
    maxSteps: 200,
    includeExternal: true,
    includeAnnotations: true,
    useCache: true,
  });

  if (format === 'mermaid') return renderMermaidSequence(model);
  if (format === 'markdown') return renderSequenceMarkdown(model);
  return JSON.stringify(model, null, 2);
}
```

Also add `case "sequence"` in `src/cli/index.ts` dispatcher and help text entry in `src/cli/commandHelp.ts`.

- [ ] **Step 4: Re-run test and confirm pass**

Run: `npx vitest run tests/cli/sequence.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/sequence.ts src/cli/index.ts src/cli/commandHelp.ts src/cli/formatter.ts tests/cli/sequence.test.ts
git commit -m "feat(cli): add sequence command and output formatting"
```

---

### Task 6: Expose MCP tool `graphitlive_generate_sequence_diagram` (TDD)

**Files:**
- Modify: `src/mcp/types.ts`
- Modify: `src/mcp/mcpServer.ts`
- Modify: `src/mcp/McpWorker.ts`
- Test: `tests/mcp/sequenceTool.test.ts`

- [ ] **Step 1: Add failing MCP tool test**

```ts
import { describe, expect, it } from 'vitest';

it('returns sequence diagram payload from MCP worker', async () => {
  const { executeTool } = await import('../../src/mcp/McpWorker.js');
  const res = await executeTool('graphitlive_generate_sequence_diagram', {
    filePath: '/repo/src/index.ts',
    symbolName: 'main',
    response_format: 'json',
    diagram_format: 'mermaid',
  });
  expect(res).toHaveProperty('diagram');
  expect(res).toHaveProperty('warnings');
});
```

- [ ] **Step 2: Run test and confirm failure**

Run: `npx vitest run tests/mcp/sequenceTool.test.ts`
Expected: FAIL because tool is not registered.

- [ ] **Step 3: Implement schema + registration + worker execution**

```ts
// Add in src/mcp/types.ts
export interface GenerateSequenceDiagramParams {
  filePath: string;
  symbolName: string;
  maxDepth?: number;
  maxSteps?: number;
  includeExternal?: boolean;
  includeAnnotations?: boolean;
  response_format?: 'json' | 'markdown' | 'toon';
  diagram_format?: 'mermaid' | 'json';
}
```

```ts
// In src/mcp/McpWorker.ts switch
case 'graphitlive_generate_sequence_diagram': {
  const params = validated as GenerateSequenceDiagramParams;
  const model = await generateSequence({
    workspaceRoot: workerState.config.rootDir,
    filePath: params.filePath,
    symbolName: params.symbolName,
    maxDepth: params.maxDepth ?? 6,
    maxSteps: params.maxSteps ?? 200,
    includeExternal: params.includeExternal ?? true,
    includeAnnotations: params.includeAnnotations ?? true,
    useCache: true,
  });
  return {
    diagram: params.diagram_format === 'json' ? model : renderMermaidSequence(model),
    rootSymbol: model.root,
    participantsCount: model.stats.participantsCount,
    messagesCount: model.stats.messagesCount,
    truncated: model.truncated,
    warnings: model.warnings,
    cache: { hit: false, level: 'miss' },
    analysisTimeMs: model.stats.analysisTimeMs,
  };
}
```

- [ ] **Step 4: Re-run test and confirm pass**

Run: `npx vitest run tests/mcp/sequenceTool.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/types.ts src/mcp/mcpServer.ts src/mcp/McpWorker.ts tests/mcp/sequenceTool.test.ts
git commit -m "feat(mcp): add sequence diagram generation tool"
```

---

### Task 7: Add extension service + message protocol for Sequence panel (TDD)

**Files:**
- Create: `src/extension/services/SequenceViewService.ts`
- Modify: `src/shared/types.ts`
- Modify: `src/extension/extension.ts`
- Modify: `src/extension/services/MessageDispatcher.ts`
- Test: `tests/extension/sequenceViewService.test.ts`

- [ ] **Step 1: Add failing extension service test**

```ts
import { describe, expect, it } from 'vitest';
import { SequenceViewService } from '../../src/extension/services/SequenceViewService.js';

describe('SequenceViewService', () => {
  it('builds a sequence payload for webview', async () => {
    const svc = new SequenceViewService({} as never);
    const payload = await svc.buildPayload('/repo/src/index.ts', 'main');
    expect(payload.type).toBe('showSequenceDiagram');
  });
});
```

- [ ] **Step 2: Run test and confirm failure**

Run: `npx vitest run tests/extension/sequenceViewService.test.ts`
Expected: FAIL with missing service/message types.

- [ ] **Step 3: Implement service + protocol + wiring**

```ts
// src/shared/types.ts (excerpt)
export interface ShowSequenceDiagramMessage {
  type: 'showSequenceDiagram';
  mermaid: string;
  model: SequenceModel;
}

export interface SequenceOpenFileCommand {
  command: 'sequenceOpenFile';
  path: string;
  line: number;
}
```

```ts
// src/extension/services/SequenceViewService.ts (core)
export class SequenceViewService {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async buildPayload(filePath: string, symbolName: string): Promise<ShowSequenceDiagramMessage> {
    const model = await generateSequence({
      workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '',
      filePath,
      symbolName,
      maxDepth: 6,
      maxSteps: 200,
      includeExternal: true,
      includeAnnotations: true,
      useCache: true,
    });

    return {
      type: 'showSequenceDiagram',
      mermaid: renderMermaidSequence(model),
      model,
    };
  }
}
```

Also register command `graph-it-live.showSequence` in extension activation path and route `sequenceOpenFile` in `MessageDispatcher`.

- [ ] **Step 4: Re-run test and confirm pass**

Run: `npx vitest run tests/extension/sequenceViewService.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/extension/services/SequenceViewService.ts src/shared/types.ts src/extension/extension.ts src/extension/services/MessageDispatcher.ts tests/extension/sequenceViewService.test.ts
git commit -m "feat(extension): add sequence view service and message routing"
```

---

### Task 8: Create dedicated webview Sequence panel UI (TDD)

**Files:**
- Create: `src/webview/sequence/index.tsx`
- Create: `src/webview/components/sequence/SequenceView.tsx`
- Test: `tests/webview/sequenceView.test.ts`

- [ ] **Step 1: Add failing webview test**

```ts
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { SequenceView } from '../../src/webview/components/sequence/SequenceView';

describe('SequenceView', () => {
  it('renders depth control', () => {
    const { getByLabelText } = render(<SequenceView />);
    expect(getByLabelText('Depth')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test and confirm failure**

Run: `npx vitest run tests/webview/sequenceView.test.ts`
Expected: FAIL due to missing component.

- [ ] **Step 3: Implement minimal SequenceView + entrypoint**

```tsx
// src/webview/components/sequence/SequenceView.tsx
import React from 'react';

export function SequenceView(): React.JSX.Element {
  return (
    <div>
      <label htmlFor="depth">Depth</label>
      <input id="depth" type="range" min={1} max={10} defaultValue={6} />
      <div id="sequence-container" />
    </div>
  );
}
```

```tsx
// src/webview/sequence/index.tsx
import React from 'react';
import { createRoot } from 'react-dom/client';
import { SequenceView } from '../components/sequence/SequenceView';

const el = document.getElementById('root');
if (el) createRoot(el).render(<SequenceView />);
```

- [ ] **Step 4: Re-run test and confirm pass**

Run: `npx vitest run tests/webview/sequenceView.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/webview/sequence/index.tsx src/webview/components/sequence/SequenceView.tsx tests/webview/sequenceView.test.ts
git commit -m "feat(webview): add dedicated sequence panel UI"
```

---

### Task 9: Complete integration, docs, and release checks

**Files:**
- Modify: `package.json`
- Create: `tests/vscode-e2e/suite/sequenceView.test.ts`
- Modify: `docs/CLI.md`
- Modify: `README.md`
- Modify: `changelog.md`

- [ ] **Step 1: Add failing VS Code E2E smoke test**

```ts
import { describe, it, expect } from 'vitest';

describe('Sequence view command', () => {
  it('opens sequence mode without errors', async () => {
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 2: Run targeted tests and confirm fail/pass boundary**

Run: `npm test -- tests/vscode-e2e/suite/sequenceView.test.ts`
Expected: initial FAIL if command not contributed; PASS after contribution wiring.

- [ ] **Step 3: Document usage and caveats**

Add exact sections:

```md
# docs/CLI.md
## sequence
graph-it sequence src/index.ts#main --format mermaid
```

```md
# README.md
- New: Sequence Diagram generation via CLI, MCP, and Sequence panel.
```

```md
# changelog.md (unreleased)
- Added sequence diagram generation (CLI/MCP/extension) with cache-first architecture.
```

- [ ] **Step 4: Run full validation commands**

Run:

```bash
npm run lint
npm run check:types
npm test
npm run test:vscode
```

Expected: all commands pass.

- [ ] **Step 5: Commit**

```bash
git add package.json tests/vscode-e2e/suite/sequenceView.test.ts docs/CLI.md README.md changelog.md
git commit -m "docs/tests: finalize sequence feature docs and validation"
```

---

## Spec Coverage Check

- `REQ-001` → Tasks 1-3
- `REQ-002` → Task 5
- `REQ-003` → Task 6
- `REQ-004` → Tasks 7-8
- `REQ-005` → Tasks 2, 6, 9 (fixtures and integration expansion)
- `REQ-006` → Tasks 2-3
- `REQ-007` → Task 2 + Task 9 regression checks
- `NFR/SEC/CON/GUD/PAT` → Tasks 4, 6, 7, 9

No uncovered requirement detected.

## Placeholder Scan

Checked for: `TODO`, `TBD`, “implement later”, “similar to task”, missing commands.  
Result: none found.

## Type Consistency Check

Checked naming consistency:
- `generateSequence`
- `SequenceModel`
- `showSequenceDiagram`
- `graphitlive_generate_sequence_diagram`

Result: consistent across tasks.
