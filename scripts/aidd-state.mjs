#!/usr/bin/env node
// Deterministic AIDD workflow state: step order, loop bounds, tier changes, human gates,
// agent handoffs and crash-safe resume. Used by the /aidd-* commands (.claude/commands/).
// Exit codes: 0 ok, 2 invalid use, 3 bound reached or gate refused (stop and ask the human).
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const WORKFLOWS = {
  epic: ['brief', 'GATE-0', 'stories', 'stories-review', 'design', 'design-review', 'ux', 'security', 'security-review', 'plan', 'plan-review', 'GATE-4'],
  feature: ['classify', 'spec', 'spec-review', 'GATE-5', 'branch', 'implement', 'checks', 'qa', 'review', 'package', 'docs', 'pr', 'ci', 'demo', 'GATE-6', 'merge'],
  'quick-win': ['branch', 'spec', 'spec-review', 'implement', 'checks', 'qa', 'review', 'pr', 'ci', 'GATE-6', 'merge'],
  bugfix: ['diagnose', 'branch', 'implement', 'checks', 'qa', 'review', 'pr', 'ci', 'GATE-6', 'merge'],
  'bug-hunt': ['investigate', 'report'],
  'leak-check': ['audit', 'report'],
  optimize: ['analyze', 'baseline', 'implement', 'measure', 'report'],
  'security-audit': ['threat-model', 'attack', 'harden', 'report'],
  adr: ['options', 'challenge', 'write', 'GATE-ADR'],
};
export const OPTIONAL_STEPS = new Set(['classify', 'spec', 'spec-review', 'ux', 'package', 'docs', 'demo', 'security', 'security-review']);
export const LIMITS = { perStep: 2, total: 3, ci: 2, diagnostic: 1 };
const DIAGNOSTIC_STEPS = new Set(['investigate', 'audit', 'measure']);
const HANDOFF_FIELDS = ['CONTEXT', 'PHASE', 'BLOCKERS', 'PRIOR OUTPUTS', 'ACTION'];
const ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export class AiddError extends Error {
  constructor(message, code = 2) {
    super(message);
    this.code = code;
  }
}

const isGate = (step) => step.startsWith('GATE-');
const now = () => new Date().toISOString();

function steps(state) {
  return WORKFLOWS[state.tier];
}

export function nextStep(state) {
  return steps(state).find((step) => !state.done.includes(step)) ?? null;
}

// Step the rework restarts from when a check, review or devil blocks.
export function rewindTarget(tier, step) {
  const list = WORKFLOWS[tier];
  if (['checks', 'qa', 'review', 'measure'].includes(step) && list.includes('implement')) return 'implement';
  if (step === 'ci' || DIAGNOSTIC_STEPS.has(step)) return step;
  if (step.endsWith('-review') || isGate(step)) return list[list.indexOf(step) - 1];
  if (['attack', 'challenge'].includes(step)) return list[list.indexOf(step) - 1];
  throw new AiddError(`Step "${step}" cannot raise a correction round in tier ${tier}.`);
}

function rewind(state, target) {
  const list = steps(state);
  const from = list.indexOf(target);
  state.done = state.done.filter((step) => list.indexOf(step) < from);
}

function log(state, event, detail = '') {
  state.history.push({ at: now(), event, detail });
  state.updatedAt = now();
}

export function createState(id, tier, parent = null) {
  if (!ID_PATTERN.test(id)) throw new AiddError(`Invalid id "${id}": use letters, digits, ".", "_" or "-" (max 64).`);
  if (!WORKFLOWS[tier]) throw new AiddError(`Unknown tier "${tier}". Known: ${Object.keys(WORKFLOWS).join(', ')}.`);
  const state = { id, tier, parent, done: [], skipped: {}, rounds: {}, totalRounds: 0, ciFixes: 0, overrides: 0, tierChanges: 0, gates: {}, running: null, artifacts: {}, handoffs: {}, history: [], closed: false };
  log(state, 'start', tier);
  return state;
}

function expectNext(state, step) {
  if (state.closed) throw new AiddError(`${state.id} is closed.`);
  const next = nextStep(state);
  if (next !== step) throw new AiddError(`Out of order: next step of ${state.id} is "${next}", not "${step}".`);
}

export function begin(state, step, agent) {
  expectNext(state, step);
  state.running = { step, agent, at: now() };
  log(state, 'begin', `${step} ${agent}`);
}

export function complete(state, step, artifacts = {}) {
  expectNext(state, step);
  if (isGate(step)) throw new AiddError(`${step} is a human gate: use "gate ${state.id} ${step} approve|reject".`);
  state.done.push(step);
  Object.assign(state.artifacts, artifacts);
  state.running = null;
  log(state, 'done', step);
}

export function skip(state, step, reason) {
  expectNext(state, step);
  if (!OPTIONAL_STEPS.has(step)) throw new AiddError(`"${step}" is mandatory and cannot be skipped.`);
  if (!reason) throw new AiddError('A skip needs --reason.');
  state.done.push(step);
  state.skipped[step] = reason;
  log(state, 'skip', `${step}: ${reason}`);
}

export function gate(state, step, decision) {
  expectNext(state, step);
  if (!isGate(step)) throw new AiddError(`"${step}" is not a human gate.`);
  if (decision === 'approve') {
    state.done.push(step);
    state.gates[step] = { decision, at: now() };
    log(state, 'gate', `${step} approved`);
    return;
  }
  if (decision !== 'reject') throw new AiddError('Gate decision must be "approve" or "reject".');
  state.gates[step] = { decision, at: now() };
  round(state, step, 'human rejected the gate');
}

function budgetLeft(state, step) {
  let perStep = LIMITS.perStep;
  if (step === 'ci') perStep = LIMITS.ci;
  else if (DIAGNOSTIC_STEPS.has(step)) perStep = LIMITS.diagnostic;
  const used = state.rounds[step] ?? 0;
  if (used >= perStep + state.overrides) return `${used} correction round(s) already used on "${step}" (limit ${perStep})`;
  if (step !== 'ci' && state.totalRounds >= LIMITS.total + state.overrides) return `${state.totalRounds} correction rounds already used on ${state.id} (limit ${LIMITS.total})`;
  return null;
}

export function round(state, step, reason = '') {
  if (state.closed) throw new AiddError(`${state.id} is closed.`);
  const target = rewindTarget(state.tier, step);
  const exhausted = budgetLeft(state, step);
  if (exhausted) {
    log(state, 'bound', `${step}: ${exhausted}`);
    throw new AiddError(`Loop bound reached: ${exhausted}. Stop and ask the human (override with "override ${state.id}").`, 3);
  }
  state.rounds[step] = (state.rounds[step] ?? 0) + 1;
  if (step === 'ci') state.ciFixes += 1;
  else state.totalRounds += 1;
  rewind(state, target);
  state.running = null;
  log(state, 'round', reason ? `${step} → ${target}: ${reason}` : `${step} → ${target}`);
  return target;
}

export function retier(state, tier) {
  if (!WORKFLOWS[tier]) throw new AiddError(`Unknown tier "${tier}".`);
  if (state.tierChanges >= 1) {
    log(state, 'bound', `tier change to ${tier} refused`);
    throw new AiddError(`${state.id} already changed tier once (${state.tier}). Stop and ask the human.`, 3);
  }
  const kept = state.done.filter((step) => WORKFLOWS[tier].includes(step) && ['branch', 'diagnose', 'classify'].includes(step));
  log(state, 'retier', `${state.tier} → ${tier}`);
  Object.assign(state, { tier, done: kept, tierChanges: state.tierChanges + 1, running: null });
}

export function override(state) {
  state.overrides += 1;
  log(state, 'override', 'human granted one more correction round');
}

export function recordHandoff(state, agent, text) {
  const missing = HANDOFF_FIELDS.filter((field) => !new RegExp(`^${field}:`, 'm').test(text));
  const format = HANDOFF_FIELDS.map((field) => field + ': ...').join(' / ');
  if (missing.length > 0) throw new AiddError(`Handoff misses: ${missing.join(', ')}. Format: ${format}.`);
  const priorLines = (/^PRIOR OUTPUTS:([\s\S]*?)^ACTION:/m.exec(text)?.[1] ?? '').split('\n').filter((line) => line.trim()).length;
  if (priorLines > 2) throw new AiddError('PRIOR OUTPUTS holds at most two lines: point to artifacts instead of pasting output.');
  state.handoffs[agent] = { at: now(), text: text.trim() };
  log(state, 'handoff', agent);
}

export function close(state) {
  const next = nextStep(state);
  if (next) throw new AiddError(`${state.id} still has step "${next}" to do.`);
  state.closed = true;
  log(state, 'close');
}

export function summary(state) {
  const next = nextStep(state);
  return {
    id: state.id,
    tier: state.tier,
    parent: state.parent,
    closed: state.closed,
    next,
    nextIsHumanGate: next ? isGate(next) : false,
    interrupted: state.running ? `${state.running.step} (${state.running.agent}) was running at ${state.running.at}: check the branch with git status, then rerun it with a fresh agent` : null,
    done: state.done,
    skipped: state.skipped,
    rounds: state.rounds,
    totalRounds: `${state.totalRounds}/${LIMITS.total + state.overrides}`,
    ciFixes: `${state.ciFixes}/${LIMITS.ci + state.overrides}`,
    tierChanges: state.tierChanges,
    gates: state.gates,
    artifacts: state.artifacts,
    handoffs: Object.fromEntries(Object.entries(state.handoffs).map(([agent, h]) => [agent, h.text])),
  };
}

// Storage: one JSON file per item, written atomically so a crash never leaves a half-written state.
export function stateDir() {
  return process.env.AIDD_STATE_DIR ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.claude', 'aidd-state');
}

function fileOf(id) {
  if (!ID_PATTERN.test(id)) throw new AiddError(`Invalid id "${id}".`);
  return path.join(stateDir(), `${id}.json`);
}

export function load(id) {
  const file = fileOf(id);
  if (!existsSync(file)) throw new AiddError(`No AIDD state for "${id}": start it with "start ${id} <tier>".`);
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new AiddError(`State file ${file} is corrupt (${error.message}): restore it or start again.`);
  }
}

export function save(state) {
  mkdirSync(stateDir(), { recursive: true });
  const file = fileOf(state.id);
  writeFileSync(`${file}.tmp`, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
}

export function listOpen() {
  if (!existsSync(stateDir())) return [];
  // One corrupt file must not hide the other items from a resume.
  return readdirSync(stateDir())
    .filter((name) => name.endsWith('.json'))
    .flatMap((name) => {
      try {
        const state = load(name.slice(0, -5));
        return state.closed ? [] : [{ id: state.id, tier: state.tier, next: nextStep(state), interrupted: Boolean(state.running), updatedAt: state.updatedAt }];
      } catch (error) {
        return [{ id: name.slice(0, -5), corrupt: error.message }];
      }
    });
}

function option(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

const USAGE = `Usage: node scripts/aidd-state.mjs <command>
  start <id> <tier> [--parent <id>]     tiers: ${Object.keys(WORKFLOWS).join(', ')}
  status [<id>]                         no id: list open items (resume after a stop or crash)
  begin <id> <step> <agent>             mark a step running before invoking its agent
  done <id> <step> [--artifact k=path]  complete the next step
  skip <id> <step> --reason <text>      skip an optional step
  gate <id> <GATE-n> approve|reject     record the human decision
  round <id> <step> [--reason <text>]   a check, review or devil blocked: rewind (bounded)
  retier <id> <tier>                    change tier once
  override <id>                         human grants one more correction round
  handoff <id> <agent> <file>           store a five-field handoff for an agent
  close <id>                            all steps done`;

export function run(argv, readText = (file) => readFileSync(file, 'utf8')) {
  const [command, id, ...rest] = argv;
  if (command === 'status' && !id) return listOpen();
  if (!command || !id) throw new AiddError(USAGE);
  if (command === 'start') {
    if (existsSync(fileOf(id))) throw new AiddError(`State for "${id}" already exists: use "status ${id}" to resume.`);
    const state = createState(id, rest[0], option(rest, '--parent') ?? null);
    save(state);
    return summary(state);
  }
  const state = load(id);
  const actions = {
    status: () => {},
    begin: () => begin(state, rest[0], rest[1] ?? 'main'),
    done: () => complete(state, rest[0], Object.fromEntries(rest.flatMap((arg, i) => (rest[i - 1] === '--artifact' ? [arg.split('=')] : [])))),
    skip: () => skip(state, rest[0], option(rest, '--reason')),
    gate: () => gate(state, rest[0], rest[1]),
    round: () => round(state, rest[0], option(rest, '--reason')),
    retier: () => retier(state, rest[0]),
    override: () => override(state),
    handoff: () => recordHandoff(state, rest[0], readText(rest[1])),
    close: () => close(state),
  };
  if (!actions[command]) throw new AiddError(USAGE);
  try {
    actions[command]();
  } finally {
    if (command !== 'status') save(state); // keep bound and rejection events even when the command fails
  }
  return summary(state);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    console.log(JSON.stringify(run(process.argv.slice(2)), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exit(error instanceof AiddError ? error.code : 1);
  }
}
