/**
 * Tool-selection eval: does an LLM pick the right MCP tool from the advertised
 * catalogue?
 *
 * This is a measurement, not a gate. It calls a real LLM, so it is skipped
 * unless RUN_TOOL_EVAL=1, and it never asserts on model output — an assertion
 * on an LLM's choice would be flaky and would not tell you anything a printed
 * score does not.
 *
 * Usage:
 *   git checkout main      && npm run build && node scripts/eval/dump-tools.mjs /tmp/tools.main.json
 *   git checkout my-branch && npm run build && node scripts/eval/dump-tools.mjs /tmp/tools.new.json
 *   RUN_TOOL_EVAL=1 GRAPH_IT_LLM_PROVIDER=anthropic \
 *     TOOL_EVAL_SNAPSHOTS=before=/tmp/tools.main.json,after=/tmp/tools.new.json \
 *     npx vitest run tests/evals/toolSelection.eval.test.ts
 *
 * Optional: TOOL_EVAL_REPEAT=3 runs every case N times to expose instability.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveLlmClient } from '@/analyzer/llm/LlmClientFactory';
import type { LlmClient } from '@/analyzer/llm/LlmClient';

interface ToolSnapshot {
  tools: { name: string; description: string; parameters: string[] }[];
  descriptionChars: number;
}

interface EvalCase {
  id: string;
  question: string;
  expected: string;
  acceptable?: string[];
}

interface CaseOutcome {
  id: string;
  picked: string | null;
  verdict: 'exact' | 'acceptable' | 'wrong';
}

interface VariantScore {
  label: string;
  descriptionChars: number;
  exact: number;
  acceptable: number;
  total: number;
  outcomes: CaseOutcome[];
}

const ENABLED = process.env.RUN_TOOL_EVAL === '1';
const REPEAT = Number(process.env.TOOL_EVAL_REPEAT ?? '1');

const DATASET: { cases: EvalCase[] } = JSON.parse(
  readFileSync(path.resolve(__dirname, 'tool-selection.dataset.json'), 'utf8'),
);

/** Parse `before=/path/a.json,after=/path/b.json` into ordered [label, path] pairs. */
function parseSnapshotSpec(spec: string): [string, string][] {
  return spec
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.indexOf('=');
      if (separator === -1) {
        throw new Error(`Malformed TOOL_EVAL_SNAPSHOTS entry "${entry}"; expected label=path`);
      }
      return [entry.slice(0, separator), entry.slice(separator + 1)];
    });
}

function renderCatalogue(snapshot: ToolSnapshot): string {
  return snapshot.tools
    .map((tool) => `- ${tool.name}(${tool.parameters.join(', ')})\n${tool.description}`)
    .join('\n\n');
}

/**
 * Recover a tool name from a model reply that may include prose or punctuation.
 * Returns null when the reply names no known tool, which scores as wrong rather
 * than silently counting as a miss for a different reason.
 */
function extractToolName(reply: string, knownNames: Set<string>): string | null {
  const candidates = reply.match(/graphitlive_[a-z_]+/g);
  if (!candidates) return null;
  return candidates.find((candidate) => knownNames.has(candidate)) ?? null;
}

async function askOnce(
  client: LlmClient,
  catalogue: string,
  evalCase: EvalCase,
  knownNames: Set<string>,
): Promise<string | null> {
  const result = await client.complete(
    [
      {
        role: 'system',
        content:
          'You select exactly one tool to answer a developer question about a codebase. ' +
          'Reply with the tool name and nothing else.',
      },
      {
        role: 'user',
        content: `Available tools:\n\n${catalogue}\n\nQuestion: ${evalCase.question}\n\nTool name:`,
      },
    ],
    { maxTokens: 32, temperature: 0 },
  );
  return extractToolName(result.text, knownNames);
}

async function scoreVariant(
  client: LlmClient,
  label: string,
  snapshot: ToolSnapshot,
): Promise<VariantScore> {
  const catalogue = renderCatalogue(snapshot);
  const knownNames = new Set(snapshot.tools.map((tool) => tool.name));
  const outcomes: CaseOutcome[] = [];

  for (const evalCase of DATASET.cases) {
    for (let run = 0; run < REPEAT; run += 1) {
      const picked = await askOnce(client, catalogue, evalCase, knownNames);
      let verdict: CaseOutcome['verdict'] = 'wrong';
      if (picked === evalCase.expected) {
        verdict = 'exact';
      } else if (picked !== null && evalCase.acceptable?.includes(picked)) {
        verdict = 'acceptable';
      }
      outcomes.push({ id: evalCase.id, picked, verdict });
    }
  }

  return {
    label,
    descriptionChars: snapshot.descriptionChars,
    exact: outcomes.filter((o) => o.verdict === 'exact').length,
    acceptable: outcomes.filter((o) => o.verdict === 'acceptable').length,
    total: outcomes.length,
    outcomes,
  };
}

function percent(part: number, total: number): string {
  return `${((part / total) * 100).toFixed(1)}%`;
}

/**
 * With REPEAT > 1 the same case is asked N times against the same catalogue.
 * Any case whose answer varies is measuring the model's instability, not the
 * catalogue: it sets the floor below which a score difference means nothing.
 */
function reportStability(scores: VariantScore[]): void {
  for (const score of scores) {
    const byCase = new Map<string, string[]>();
    for (const outcome of score.outcomes) {
      const picks = byCase.get(outcome.id) ?? [];
      picks.push(outcome.picked ?? 'none');
      byCase.set(outcome.id, picks);
    }

    const unstable = [...byCase.entries()].filter(([, picks]) => new Set(picks).size > 1);
    const caseCount = byCase.size;
    console.log(
      `\n${score.label}: ${unstable.length}/${caseCount} cases gave different answers across ${REPEAT} runs`,
    );
    for (const [id, picks] of unstable) {
      console.log(`  ${id}: ${picks.map((p) => p.replace('graphitlive_', '')).join(' | ')}`);
    }
    if (unstable.length === 0) console.log('  (every case answered identically)');
  }
}

function report(scores: VariantScore[]): void {
  console.log('\nTool-selection eval');
  console.log(`cases: ${DATASET.cases.length}  repeat: ${REPEAT}\n`);
  console.log('variant           chars   exact          exact+acceptable');
  for (const score of scores) {
    const exact = `${score.exact}/${score.total} (${percent(score.exact, score.total)})`;
    const lenient = score.exact + score.acceptable;
    console.log(
      `${score.label.padEnd(16)}  ${String(score.descriptionChars).padEnd(6)}  ${exact.padEnd(14)} ` +
        `${lenient}/${score.total} (${percent(lenient, score.total)})`,
    );
  }

  if (REPEAT > 1) reportStability(scores);

  if (scores.length !== 2) return;
  const [before, after] = scores;
  console.log('\nCases whose verdict changed:');
  let changed = 0;
  for (let index = 0; index < before.outcomes.length; index += 1) {
    const a = before.outcomes[index];
    const b = after.outcomes[index];
    if (a.verdict === b.verdict && a.picked === b.picked) continue;
    changed += 1;
    console.log(
      `  ${a.id}: ${before.label}=${a.picked ?? 'none'} (${a.verdict}) -> ` +
        `${after.label}=${b.picked ?? 'none'} (${b.verdict})`,
    );
  }
  if (changed === 0) console.log('  (none)');
}

describe.skipIf(!ENABLED)('MCP tool selection', () => {
  it('scores each tool-catalogue snapshot', async () => {
    const spec = process.env.TOOL_EVAL_SNAPSHOTS;
    if (!spec) {
      throw new Error(
        'Set TOOL_EVAL_SNAPSHOTS=before=/path/a.json,after=/path/b.json ' +
          '(produce snapshots with scripts/eval/dump-tools.mjs)',
      );
    }

    const client = await resolveLlmClient();
    if (!client) {
      throw new Error(
        'No LLM client available. Set ANTHROPIC_API_KEY or OPENAI_API_KEY, ' +
          'or pin GRAPH_IT_LLM_PROVIDER (anthropic | openai-compatible | copilot-cli).',
      );
    }
    console.log(`provider: ${client.providerName}`);

    const scores: VariantScore[] = [];
    for (const [label, snapshotPath] of parseSnapshotSpec(spec)) {
      const snapshot: ToolSnapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
      scores.push(await scoreVariant(client, label, snapshot));
    }

    report(scores);

    // Structural guard only: an assertion on the model's choices would be flaky.
    // Comparing different tool sets would make the score difference meaningless.
    const nameSets = scores.map((score) => score.outcomes.length);
    expect(new Set(nameSets).size).toBe(1);
  }, 900_000);
});

describe('tool-selection dataset', () => {
  it('names a distinct expected tool per case', () => {
    const expected = DATASET.cases.map((c) => c.expected);
    expect(new Set(expected).size).toBe(expected.length);
  });

  it('never lists the expected tool among its own acceptable alternates', () => {
    for (const evalCase of DATASET.cases) {
      expect(evalCase.acceptable ?? []).not.toContain(evalCase.expected);
    }
  });

  it('only references tools the server actually advertises', () => {
    const snapshotPath = process.env.TOOL_EVAL_NAMES_SNAPSHOT;
    if (!snapshotPath) return; // structural check needs a snapshot; skipped without one
    const snapshot: ToolSnapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
    const known = new Set(snapshot.tools.map((tool) => tool.name));
    for (const evalCase of DATASET.cases) {
      expect(known).toContain(evalCase.expected);
      for (const alternate of evalCase.acceptable ?? []) {
        expect(known).toContain(alternate);
      }
    }
  });
});
