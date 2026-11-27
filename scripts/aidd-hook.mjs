#!/usr/bin/env node
// Claude Code hooks that make the /aidd-* commands follow scripts/aidd-state.mjs.
//   agent   (PreToolUse Agent): an AIDD agent runs only for a step started with `begin`.
//   merge   (PreToolUse Bash):  `gh pr merge` needs GATE-6 approved for the current branch.
//   session (SessionStart):     lists open items so a stopped or crashed workflow resumes.
// Exit 2 blocks the tool call; stderr tells Claude what to run instead.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { listOpen, load } from './aidd-state.mjs';

const STATE = 'node scripts/aidd-state.mjs';

function openStates() {
  return listOpen().flatMap((item) => (item.corrupt ? [] : [load(item.id)]));
}

export function checkAgent(input, agentsDir) {
  const agent = input.tool_input?.subagent_type;
  if (!agent || !existsSync(path.join(agentsDir, `${agent}.md`))) return null; // not an AIDD agent
  if (openStates().some((state) => state.running?.agent === agent)) return null;
  const open = listOpen().filter((item) => !item.corrupt).map((item) => `${item.id} (next: ${item.next})`).join(', ') || 'none';
  return `AIDD agent ${agent} has no started step. Run "${STATE} begin <id> <step> ${agent}" first. Open items: ${open}.`;
}

export function checkMerge(input, branch) {
  if (!/\bgh\s+pr\s+merge\b/.test(input.tool_input?.command ?? '')) return null;
  const item = openStates().find((state) => state.artifacts?.branch === branch);
  if (!item) return `No AIDD item records branch "${branch}". Record it with "${STATE} done <id> branch --artifact branch=${branch}", then pass GATE-6.`;
  if (item.gates?.['GATE-6']?.decision !== 'approve') return `${item.id}: GATE-6 is not approved. Ask the human, then run "${STATE} gate ${item.id} GATE-6 approve".`;
  return null;
}

export function sessionContext() {
  const items = listOpen();
  if (items.length === 0) return '';
  const lines = items.map((item) => {
    if (item.corrupt) return `- ${item.id}: corrupt state (${item.corrupt})`;
    const resume = item.interrupted ? ' (interrupted step: check git status, rerun with a fresh agent)' : '';
    return `- ${item.id} [${item.tier}] next: ${item.next}${resume}`;
  });
  return [`Open AIDD items (${STATE} status <id>):`, ...lines].join('\n');
}

function currentBranch() {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim(); // NOSONAR S4036: developer tool, trusted PATH
  } catch {
    return '';
  }
}

export function main(mode, stdinText, { agentsDir, branch } = {}) {
  const input = stdinText ? JSON.parse(stdinText) : {};
  if (mode === 'session') return { code: 0, out: sessionContext() };
  const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  let reason = null;
  if (mode === 'agent') reason = checkAgent(input, agentsDir ?? path.join(projectDir, '.claude', 'agents'));
  else if (mode === 'merge') reason = checkMerge(input, branch ?? currentBranch());
  else return { code: 1, err: `Unknown hook mode "${mode}": use agent, merge or session.` };
  return reason ? { code: 2, err: reason } : { code: 0 };
}

export function cli(argv, readStdin) {
  try {
    return main(argv[0], argv[0] === 'session' ? '' : readStdin());
  } catch (error) {
    return { code: 1, err: `aidd-hook: ${error.message}` }; // a broken hook warns (exit 1), it never blocks
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const result = cli(process.argv.slice(2), () => readFileSync(0, 'utf8'));
  if (result.out) console.log(result.out);
  if (result.err) console.error(result.err);
  process.exit(result.code);
}
