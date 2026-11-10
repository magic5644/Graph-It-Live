// Agent benchmark core (#399, #675): task schema, answer-key check against the
// pinned corpus commit, deterministic scorer, automatic verdicts and report.
// Pure functions except checkAnswerKeys, which reads git objects only (no
// worktree, no index). Spawns no client and calls no model.

import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';

export const CLASSES = ['known-file', 'localization', 'callers-impact', 'multi-file-contract'];
export const FIELD_TYPES = ['string', 'string[]', 'path', 'path[]', 'number', 'boolean'];
export const RUN_STATUSES = ['completed', 'failed', 'timeout', 'rate-limited', 'incomplete'];
export const METRICS = ['toolCalls', 'turns', 'latencyMs', 'inputTokens', 'cacheWriteTokens', 'cacheReadTokens', 'outputTokens', 'notionalCostUsd'];
export const RETRIEVAL_METRICS = ['cl100kTokens', 'jsonChars', 'toonChars'];

const ID = /^[a-z0-9][a-z0-9-]*$/;
const SHA = /^[0-9a-f]{40}$/;
const EPSILON = 1e-9;

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Repository-relative path with '/' separators: no absolute path, no '..', no leading '-'. */
export function isSafeRelativePath(value) {
  return typeof value === 'string' && value.length > 0 && !value.startsWith('/') && !value.startsWith('-')
    && !/^[a-zA-Z]:/.test(value) && !value.includes('\\') && !value.includes('\0')
    && !value.split('/').some((segment) => segment === '..' || segment === '' || segment === '.');
}

function valueMatchesType(value, type) {
  switch (type) {
    case 'string': return typeof value === 'string' && value.length > 0;
    case 'path': return isSafeRelativePath(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'boolean': return typeof value === 'boolean';
    case 'string[]': return Array.isArray(value) && value.every((item) => valueMatchesType(item, 'string'));
    case 'path[]': return Array.isArray(value) && value.every(isSafeRelativePath);
    default: return false;
  }
}

function validateEvidence(task, where) {
  if (!Array.isArray(task.evidence) || task.evidence.length === 0) return [`${where}: evidence must be a non-empty array`];
  return task.evidence.flatMap((entry, index) => {
    const at = `${where}.evidence[${index}]`;
    if (!isObject(entry) || !isSafeRelativePath(entry.path)) return [`${at}.path must be a safe relative path`];
    const symbols = entry.symbols ?? [];
    return Array.isArray(symbols) && symbols.every((symbol) => typeof symbol === 'string' && /^[\w$]+$/.test(symbol))
      ? []
      : [`${at}.symbols must be identifiers`];
  });
}

function validateTask(task, index) {
  const where = `tasks[${index}]`;
  if (!isObject(task)) return [`${where} must be an object`];
  const errors = [];
  if (typeof task.id !== 'string' || !ID.test(task.id)) errors.push(`${where}.id must match ${ID}`);
  if (!CLASSES.includes(task.class)) errors.push(`${where}.class must be one of ${CLASSES.join(', ')}`);
  if (typeof task.prompt !== 'string' || task.prompt.trim() === '') errors.push(`${where}.prompt must be a non-empty string`);
  if (!isObject(task.answerShape) || Object.keys(task.answerShape).length === 0) {
    return [...errors, `${where}.answerShape must be a non-empty object`];
  }
  if (!isObject(task.key)) return [...errors, `${where}.key must be an object`];
  for (const [field, type] of Object.entries(task.answerShape)) {
    if (!FIELD_TYPES.includes(type)) errors.push(`${where}.answerShape.${field} has unknown type ${type}`);
    else if (!valueMatchesType(task.key[field], type)) errors.push(`${where}.key.${field} must be a ${type}`);
  }
  for (const field of Object.keys(task.key)) {
    if (!(field in task.answerShape)) errors.push(`${where}.key.${field} is not in answerShape`);
  }
  return [...errors, ...validateEvidence(task, where)];
}

/** Validates the task pack against the frozen hypotheses: one entry per class count. Returns error strings. */
export function validateTasks(pack, hypotheses) {
  if (!isObject(pack) || !Array.isArray(pack.tasks)) return ['tasks file must have a tasks array'];
  const errors = pack.tasks.flatMap(validateTask);
  const ids = pack.tasks.map((task) => task?.id);
  for (const id of new Set(ids.filter((value, index) => ids.indexOf(value) !== index))) errors.push(`duplicate task id ${id}`);
  for (const [name, spec] of Object.entries(hypotheses?.classes ?? {})) {
    const count = pack.tasks.filter((task) => task?.class === name).length;
    if (count !== spec.tasks) errors.push(`class ${name} needs ${spec.tasks} task(s), found ${count}`);
  }
  if (!SHA.test(hypotheses?.corpus?.commit ?? '')) errors.push('hypotheses corpus.commit must be a full 40-character SHA');
  return errors;
}

function git(repoRoot, args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 }); // NOSONAR S4036: developer tool, trusted PATH
}

function gitObjectExists(repoRoot, spec) {
  try {
    git(repoRoot, ['cat-file', '-e', spec]);
    return true;
  } catch {
    return false;
  }
}

/** Every path a key or its evidence names, each with the symbols that must appear in it. */
function referencedFiles(tasks) {
  const files = new Map();
  const add = (path, symbols = []) => files.set(path, [...(files.get(path) ?? []), ...symbols]);
  for (const task of tasks) {
    for (const [field, type] of Object.entries(task.answerShape)) {
      if (type === 'path') add(task.key[field]);
      if (type === 'path[]') task.key[field].forEach((path) => add(path));
    }
    for (const entry of task.evidence) add(entry.path, entry.symbols);
  }
  return files;
}

/**
 * Checks every answer-key path and evidence symbol against the pinned commit,
 * from git objects only (`git cat-file -e`, `git show`). A live run calls it
 * before the first prompt and stops when ok is false, so a bad key costs no tokens.
 */
export function checkAnswerKeys(tasks, commit, repoRoot) {
  if (!SHA.test(commit)) return { ok: false, errors: [`corpus commit ${commit} is not a full SHA`], corpusHash: null };
  if (!gitObjectExists(repoRoot, `${commit}^{commit}`)) {
    return { ok: false, errors: [`corpus commit ${commit} is not in this repository (fetch it first)`], corpusHash: null };
  }
  const errors = [];
  for (const [path, symbols] of referencedFiles(tasks)) {
    if (!gitObjectExists(repoRoot, `${commit}:${path}`)) {
      errors.push(`${path} does not exist at ${commit.slice(0, 12)}`);
      continue;
    }
    // Whole identifiers only: `isInIgnoredDirectoryX` does not prove `isInIgnoredDirectory`.
    const identifiers = new Set(symbols.length > 0 ? git(repoRoot, ['show', `${commit}:${path}`]).split(/[^\w$]+/) : []);
    for (const symbol of new Set(symbols)) {
      if (!identifiers.has(symbol)) {
        errors.push(`${symbol} not found in ${path} at ${commit.slice(0, 12)}`);
      }
    }
  }
  return { ok: errors.length === 0, errors, corpusHash: git(repoRoot, ['rev-parse', `${commit}^{tree}`]).trim() };
}

/** Parses an answer: one JSON object, optionally wrapped in a single ```json fence. */
export function parseAnswer(text) {
  if (typeof text !== 'string' || text.trim() === '') return { ok: false, error: 'empty response' };
  let body = text.trim();
  if (body.length >= 6 && body.startsWith('```') && body.endsWith('```')) body = body.slice(3, -3).replace(/^json/, '');
  try {
    const value = JSON.parse(body);
    return isObject(value) ? { ok: true, value } : { ok: false, error: 'response is not a JSON object' };
  } catch (error) {
    return { ok: false, error: `malformed JSON: ${error.message}` };
  }
}

const normalizeItem = (value, isPath) => {
  const text = String(value).trim();
  return isPath ? text.replaceAll('\\', '/').replace(/^\.\//, '') : text;
};

function scoreList(answer, key, isPath) {
  if (!Array.isArray(answer)) return { score: 0, precision: 0, recall: 0 };
  const expected = new Set(key.map((item) => normalizeItem(item, isPath)));
  const given = new Set(answer.filter((item) => typeof item === 'string').map((item) => normalizeItem(item, isPath)));
  if (expected.size === 0 && given.size === 0) return { score: 1, precision: 1, recall: 1 };
  const hits = [...given].filter((item) => expected.has(item)).length;
  const precision = given.size === 0 ? 0 : hits / given.size;
  const recall = expected.size === 0 ? 0 : hits / expected.size;
  const score = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { score, precision, recall };
}

function scoreField(answer, key, type) {
  if (type === 'string[]' || type === 'path[]') return scoreList(answer, key, type === 'path[]');
  if (type === 'string' || type === 'path') {
    return { score: typeof answer === 'string' && normalizeItem(answer, type === 'path') === key ? 1 : 0 };
  }
  return { score: answer === key ? 1 : 0 };
}

/** Scores one response against a task key: exact match per scalar field, F1 of precision/recall per list. */
export function scoreAnswer(task, text) {
  const parsed = parseAnswer(text);
  if (!parsed.ok) {
    const hasList = Object.values(task.answerShape).some((type) => type.endsWith('[]'));
    return { score: 0, recall: hasList ? 0 : null, malformed: true, error: parsed.error, fields: {} };
  }
  const fields = Object.fromEntries(Object.entries(task.answerShape)
    .map(([field, type]) => [field, scoreField(parsed.value[field], task.key[field], type)]));
  const scores = Object.values(fields);
  const recalls = scores.filter((field) => field.recall !== undefined).map((field) => field.recall);
  return {
    score: scores.reduce((sum, field) => sum + field.score, 0) / scores.length,
    recall: recalls.length === 0 ? null : recalls.reduce((sum, value) => sum + value, 0) / recalls.length,
    malformed: false,
    fields,
  };
}

/** Non-cached input (cache writes included) plus output; cache reads are input, never savings. */
export function providerTokens(metrics) {
  // A client without cache writes reports cacheWriteTokens: 0; null or absent means unavailable.
  const parts = [metrics?.inputTokens, metrics?.cacheWriteTokens, metrics?.outputTokens];
  return parts.every((value) => typeof value === 'number') ? parts.reduce((sum, value) => sum + value, 0) : null;
}

const mean = (values) => (values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length);

/** Mean of a metric over completed runs; null ("unavailable") when any completed run lacks it. */
function meanAvailable(runs, read) {
  const values = runs.map(read);
  return values.length > 0 && values.every((value) => typeof value === 'number') ? mean(values) : null;
}

function buildCell(task, arm, runs) {
  const completed = runs.filter((run) => run.status === 'completed');
  const metrics = Object.fromEntries(METRICS.map((name) => [name, meanAvailable(completed, (run) => run.metrics?.[name])]));
  return {
    taskId: task.id,
    class: task.class,
    arm,
    runs: runs.length,
    completed: completed.length,
    statuses: runs.map((run) => run.status),
    correctness: mean(completed.map((run) => run.scoring.score)),
    recall: meanAvailable(completed, (run) => run.scoring.recall),
    metrics,
    providerTokens: meanAvailable(completed, (run) => providerTokens(run.metrics)),
    retrieval: Object.fromEntries(RETRIEVAL_METRICS.map((name) => [name, meanAvailable(completed, (run) => run.retrieval?.[name])])),
  };
}

const sumOrNull = (values) => (values.every((value) => typeof value === 'number') ? values.reduce((sum, value) => sum + value, 0) : null);

function classTotals(cells) {
  return {
    correctness: sumOrNull(cells.map((cell) => cell.correctness)),
    recall: sumOrNull(cells.map((cell) => cell.recall)),
    toolCalls: sumOrNull(cells.map((cell) => cell.metrics.toolCalls)),
    providerTokens: sumOrNull(cells.map((cell) => cell.providerTokens)),
  };
}

/** (native - graph) / native; null when native is 0 or either value is unavailable. */
export function reduction(native, graph) {
  return typeof native === 'number' && typeof graph === 'number' && native !== 0 ? (native - graph) / native : null;
}

function knownFileLimits(spec, nativeCells, graphCells) {
  let unavailable = false;
  for (const [index, native] of nativeCells.entries()) {
    const graph = graphCells[index];
    const extraCalls = typeof native.metrics.toolCalls === 'number' && typeof graph.metrics.toolCalls === 'number'
      ? graph.metrics.toolCalls - native.metrics.toolCalls : null;
    const tokenIncrease = reduction(native.providerTokens, graph.providerTokens);
    if (extraCalls !== null && extraCalls > spec.maxExtraToolCallsPerTask + EPSILON) {
      return { exceeded: `${native.taskId}: +${extraCalls} tool calls (limit +${spec.maxExtraToolCallsPerTask})` };
    }
    if (tokenIncrease !== null && -tokenIncrease > spec.maxTokenIncrease + EPSILON) {
      return { exceeded: `${native.taskId}: +${Math.round(-tokenIncrease * 100)} % provider tokens (limit +${spec.maxTokenIncrease * 100} %)` };
    }
    unavailable ||= extraCalls === null || tokenIncrease === null;
  }
  return { exceeded: null, unavailable };
}

function efficiencyVerdict(spec, totals) {
  const reductions = Object.fromEntries(spec.reductionMetrics.map((name) => [name, reduction(totals.native[name], totals.graph[name])]));
  const met = Object.entries(reductions).filter(([, value]) => value !== null && value >= spec.minReduction - EPSILON);
  if (met.length > 0) return { verdict: 'confirmed', reason: `${met.map(([name]) => name).join(' and ')} reduced by >= ${spec.minReduction * 100} %`, reductions };
  const anyAvailable = Object.values(reductions).some((value) => value !== null);
  return { verdict: 'not confirmed', reason: anyAvailable ? `reduction below ${spec.minReduction * 100} %` : 'efficiency metrics unavailable', reductions };
}

function knownFileVerdict(spec, totals, nativeCells, graphCells) {
  const limits = knownFileLimits(spec, nativeCells, graphCells);
  if (limits.exceeded) return { verdict: 'refuted', reason: `control limit exceeded: ${limits.exceeded}` };
  if (totals.graph.correctness > totals.native.correctness + EPSILON) return { verdict: 'not confirmed', reason: 'correctness differs (higher in graph arm)' };
  if (limits.unavailable) return { verdict: 'not confirmed', reason: 'tool calls or provider tokens unavailable' };
  return { verdict: 'confirmed', reason: 'same correctness, within +1 tool call and +25 % provider tokens' };
}

function contractVerdict(totals) {
  const extra = reduction(totals.native.providerTokens, totals.graph.providerTokens);
  if (extra === null) return { verdict: 'confirmed', reason: 'correctness >= native; token cost unavailable' };
  const sign = extra <= 0 ? '+' : '-';
  return { verdict: 'confirmed', reason: `correctness >= native; provider tokens ${sign}${Math.round(Math.abs(extra) * 100)} %` };
}

function decide(name, spec, totals, nativeCells, graphCells) {
  if (totals.graph.correctness < totals.native.correctness - EPSILON) return { verdict: 'refuted', reason: 'lower correctness than native' };
  if (spec.minRecallDelta !== undefined) {
    if (totals.native.recall === null || totals.graph.recall === null) return { verdict: 'not confirmed', reason: 'caller recall unavailable' };
    if (totals.graph.recall < totals.native.recall - EPSILON) return { verdict: 'refuted', reason: 'lower caller recall than native' };
  }
  if (name === 'known-file') return knownFileVerdict(spec, totals, nativeCells, graphCells);
  return spec.reductionMetrics ? efficiencyVerdict(spec, totals) : contractVerdict(totals);
}

/** First task of a class without a completed run in an arm (a deselected arm counts as missing). */
function missingRun(nativeCells, graphCells) {
  for (const [index, native] of nativeCells.entries()) {
    if (native.completed === 0) return `${native.taskId} has no completed run in the native arm`;
    if ((graphCells[index]?.completed ?? 0) === 0) return `${native.taskId} has no completed run in the graph arm`;
  }
  return null;
}

/** One verdict per class: confirmed / not confirmed / refuted, with its sample size. Correctness is compared before any saving. */
export function computeVerdicts(hypotheses, cells, client) {
  return Object.entries(hypotheses.classes).map(([name, spec]) => {
    const nativeCells = cells.filter((cell) => cell.class === name && cell.arm === 'native');
    const graphCells = nativeCells.map((cell) => cells.find((other) => other.taskId === cell.taskId && other.arm === 'graph'));
    const sample = {
      tasks: nativeCells.length,
      runs: { native: nativeCells.reduce((sum, cell) => sum + cell.completed, 0), graph: graphCells.reduce((sum, cell) => sum + (cell?.completed ?? 0), 0) },
      note: 'Not statistically significant.',
    };
    const base = { class: name, client, hypothesis: spec.hypothesis, sample };
    const gap = nativeCells.length === 0 ? 'no task run' : missingRun(nativeCells, graphCells);
    if (gap) return { ...base, verdict: 'not confirmed', reason: gap, totals: null, reductions: null };
    const totals = { native: classTotals(nativeCells), graph: classTotals(graphCells) };
    const { verdict, reason, reductions = null } = decide(name, spec, totals, nativeCells, graphCells);
    return { ...base, verdict, reason, totals, reductions };
  });
}

/** Linear e-mail test on one word; a version pin such as `graph-it-live@1.24.2` is not an address (its domain must end in letters). */
function isEmail(word) {
  const at = word.indexOf('@');
  const domain = word.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  return at > 0 && dot > 0 && !domain.includes('@') && /^[a-z]{2,}$/i.test(domain.slice(dot + 1));
}

/** Removes credentials, e-mail addresses and the home directory from recorded prompts and responses. */
export function sanitize(text, home = homedir()) {
  if (typeof text !== 'string') return text;
  let result = text
    .replaceAll(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{10,}/g, '[REDACTED_KEY]')
    .replaceAll(/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '[REDACTED_TOKEN]')
    .replaceAll(/\b(Bearer\s+)[A-Za-z0-9._~+/-]{10,}=*/g, '$1[REDACTED_TOKEN]')
    .split(/([\s()<>"',;]+)/)
    .map((word) => (isEmail(word) ? '[REDACTED_EMAIL]' : word))
    .join('');
  if (home && home.length > 1) result = result.replaceAll(home, '~');
  return result;
}

/** Validates recorded runs at the trust boundary: known task and arm, known status, response string. */
export function validateRuns(runs, tasks, arms) {
  if (!Array.isArray(runs)) return ['runs must be an array'];
  const ids = new Set(tasks.map((task) => task.id));
  return runs.flatMap((run, index) => {
    const at = `runs[${index}]`;
    if (!isObject(run)) return [`${at} must be an object`];
    const errors = [];
    if (!ids.has(run.taskId)) errors.push(`${at}.taskId ${run.taskId} is not a known task`);
    if (!arms.includes(run.arm)) errors.push(`${at}.arm must be one of ${arms.join(', ')}`);
    if (run.status !== undefined && !RUN_STATUSES.includes(run.status)) errors.push(`${at}.status must be one of ${RUN_STATUSES.join(', ')}`);
    if (run.response !== undefined && run.response !== null && typeof run.response !== 'string') errors.push(`${at}.response must be a string`);
    for (const group of ['metrics', 'retrieval']) {
      if (run[group] !== undefined && !isObject(run[group])) errors.push(`${at}.${group} must be an object`);
    }
    return errors;
  });
}

/**
 * Builds the report from recorded runs: every run is kept (failures and
 * incomplete runs included), scored when completed, aggregated per task and
 * arm, then judged per class.
 */
export function buildReport({ meta, tasks, hypotheses, arms, runs }) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const scored = runs.map((run) => {
    const task = byId.get(run.taskId);
    const status = run.status ?? (typeof run.response === 'string' && run.response.trim() !== '' ? 'completed' : 'incomplete');
    return {
      taskId: run.taskId,
      class: task.class,
      arm: run.arm,
      repetition: run.repetition ?? 1,
      status,
      error: sanitize(run.error ?? null),
      prompt: sanitize(run.prompt ?? null),
      response: sanitize(run.response ?? null),
      metrics: Object.fromEntries(METRICS.map((name) => [name, typeof run.metrics?.[name] === 'number' ? run.metrics[name] : null])),
      retrieval: Object.fromEntries(RETRIEVAL_METRICS.map((name) => [name, typeof run.retrieval?.[name] === 'number' ? run.retrieval[name] : null])),
      scoring: status === 'completed' ? scoreAnswer(task, run.response) : null,
    };
  });
  const cells = tasks.flatMap((task) => arms.map((arm) => buildCell(task, arm, scored.filter((run) => run.taskId === task.id && run.arm === arm))));
  const repetitions = Math.max(0, ...cells.map((cell) => cell.runs));
  return {
    meta: { ...meta, repetitions },
    verdicts: computeVerdicts(hypotheses, cells, meta.client),
    cells,
    runs: scored,
    limits: [
      'Corpus: this repository at one pinned commit; results do not generalize to other languages or large private repositories.',
      'One repetition by default and 1-2 tasks per class: verdicts detect large differences only and are never statistically significant.',
      'Clients differ in automation and observable metrics; the report does not imply feature parity.',
      'Notional cost is computed by the client, never actual spend. cl100k_base and JSON/TOON sizes are retrieval estimates, not provider usage.',
    ],
  };
}

const show = (value, digits = 0) => (typeof value === 'number' ? value.toFixed(digits) : 'unavailable');
const percent = (value) => (typeof value === 'number' ? `${Math.round(value * 100)} %` : 'n/a');

/** Markdown summary: verdicts first, then per task and arm (correctness before cost), then failures and limits. */
export function renderMarkdown(report) {
  const { meta } = report;
  const tag = meta.corpusTag ? ` (${meta.corpusTag})` : '';
  const failures = report.runs.filter((run) => run.status !== 'completed' || run.scoring?.malformed);
  const failureLine = (run) => {
    const malformed = run.scoring?.malformed ? ` (${run.scoring.error})` : '';
    const error = run.error ? `: ${run.error}` : '';
    return `- ${run.taskId} / ${run.arm} #${run.repetition}: ${run.status}${malformed}${error}`;
  };
  return [
    `# Agent benchmark: ${meta.client ?? 'unknown client'}`,
    '',
    `- Corpus: \`${meta.corpusCommit}\`${tag}, tree \`${meta.corpusHash ?? 'unknown'}\``,
    `- Harness: \`${meta.harnessCommit ?? 'unknown'}\`, Graph-It-Live ${meta.graphItLiveVersion ?? 'unknown'}`,
    `- Client: ${meta.client ?? 'unknown'} ${meta.clientVersion ?? ''}, model ${meta.model ?? 'unknown'}, effort ${meta.effort ?? 'unknown'}`,
    `- Index: ${meta.indexState ?? 'unknown'}; repetitions per cell: up to ${meta.repetitions}; generated ${meta.generatedAt ?? ''}`,
    '',
    '## Verdicts',
    '',
    '| Class | Verdict | Correctness native / graph | Tool-call reduction | Provider-token reduction | Sample | Reason |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...report.verdicts.map((verdict) => `| ${verdict.class} | **${verdict.verdict}** | ${show(verdict.totals?.native.correctness, 2)} / ${show(verdict.totals?.graph.correctness, 2)} | ${percent(verdict.reductions?.toolCalls)} | ${percent(verdict.reductions?.providerTokens)} | ${verdict.sample.tasks} task(s), ${verdict.sample.runs.native}+${verdict.sample.runs.graph} run(s) | ${verdict.reason} |`),
    '',
    'Verdicts are computed automatically from the frozen hypotheses and are not statistically significant.',
    '',
    '## Runs per task and arm',
    '',
    '| Task | Class | Arm | Completed | Correctness | Recall | Tool calls | Turns | Latency ms | Input (uncached) | Cache write | Cache read (input) | Output | Notional cost USD | cl100k_base | JSON / TOON chars |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...report.cells.map((cell) => `| ${cell.taskId} | ${cell.class} | ${cell.arm} | ${cell.completed}/${cell.runs} | ${show(cell.correctness, 2)} | ${show(cell.recall, 2)} | ${show(cell.metrics.toolCalls, 1)} | ${show(cell.metrics.turns, 1)} | ${show(cell.metrics.latencyMs)} | ${show(cell.metrics.inputTokens)} | ${show(cell.metrics.cacheWriteTokens)} | ${show(cell.metrics.cacheReadTokens)} | ${show(cell.metrics.outputTokens)} | ${show(cell.metrics.notionalCostUsd, 4)} | ${show(cell.retrieval.cl100kTokens)} | ${show(cell.retrieval.jsonChars)} / ${show(cell.retrieval.toonChars)} |`),
    '',
    '## Failures and incomplete runs',
    '',
    ...(failures.length === 0 ? ['None.'] : failures.map(failureLine)),
    '',
    '## Limits',
    '',
    ...report.limits.map((limit) => `- ${limit}`),
  ].join('\n');
}
