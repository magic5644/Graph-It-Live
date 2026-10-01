/**
 * Ink REPL slash palette tests: canonical commands only, grouped by intent,
 * hidden aliases still resolved for argument completion.
 */

import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { filterSlashCommands, getSlashCommandHelpLines } from '../../src/cli/repl/ink/ReplInkApp';
import { buildMainActionChoices } from '../../src/cli/repl/prompts';

const HIDDEN_ALIASES = ['/path', '/deps', '/dependencies', '/deps-in', '/deps-out', '/path-in', '/path-out', '/cycle'];

const workspaceRoot = path.resolve('/workspace');
const allFiles = [
  path.join(workspaceRoot, 'src', 'cli', 'index.ts'),
  path.join(workspaceRoot, 'src', 'shared', 'path.ts'),
];

describe('Ink slash palette', () => {
  it('lists only canonical commands, grouped by intent', () => {
    const entries = filterSlashCommands('/', allFiles, workspaceRoot);
    const commands = entries.map((entry) => entry.command);

    expect(commands).toContain('/scope');
    expect(commands).not.toContain('/command');
    for (const alias of HIDDEN_ALIASES) {
      expect(commands).not.toContain(alias);
    }

    const groups = entries.map((entry) => entry.group);
    expect([...new Set(groups)]).toEqual(['Navigate', 'Understand', 'Relations', 'Workspace', 'Output', 'Session']);
    // Each group is contiguous: no group appears again after another one.
    const firstIndexOfEachGroup = [...new Set(groups)].map((group) => groups.indexOf(group));
    expect(firstIndexOfEachGroup).toEqual([...firstIndexOfEachGroup].sort((left, right) => left - right));
    expect(groups.lastIndexOf('Navigate')).toBeLessThan(groups.indexOf('Understand'));
  });

  it('suggests directories for the /path alias as for /scope', () => {
    const scope = filterSlashCommands('/scope src', allFiles, workspaceRoot).map((entry) => entry.command);
    const alias = filterSlashCommands('/path src', allFiles, workspaceRoot).map((entry) => entry.command);

    expect(scope).toEqual(['src', 'src/cli', 'src/shared']);
    expect(alias).toEqual(scope);
  });

  it('suggests files for a typed dependency alias', () => {
    const suggestions = filterSlashCommands('/deps src/cli', allFiles, workspaceRoot);

    expect(suggestions.map((entry) => entry.command)).toContain('src/cli/index.ts');
  });

  it('returns no argument suggestions for an unknown command', () => {
    expect(filterSlashCommands('/unknown src', allFiles, workspaceRoot)).toEqual([]);
  });

  it('builds forward-slash directory suggestions from Windows-style paths', () => {
    const windowsRoot = String.raw`C:\repo`;
    const windowsFiles = [String.raw`C:\repo\src\cli\index.ts`];

    const suggestions = [
      ...filterSlashCommands('/scope ', windowsFiles, windowsRoot),
      ...filterSlashCommands('/path-in ', windowsFiles, windowsRoot),
    ].map((entry) => entry.command);

    expect(suggestions.length).toBeGreaterThan(0);
    for (const suggestion of suggestions) {
      expect(suggestion).not.toContain('\\');
    }
  });

  it('prints group headings and the alias list in help', () => {
    const lines = getSlashCommandHelpLines();
    const text = lines.join('\n');

    expect(text).toContain('Navigate');
    expect(text).toContain('/scope <directory>');
    expect(text).toContain('/path → /scope');
    expect(text).toContain('/deps-in → /check-dependencies');
    expect(lines.some((line) => line.trimStart().startsWith('/command'))).toBe(false);
    expect(lines.some((line) => line.trimStart().startsWith('/deps '))).toBe(false);
  });
});

describe('legacy main palette', () => {
  it('shows each intent group once, in order, with /quit and without /command', () => {
    const choices = buildMainActionChoices('/');
    const headers = choices.filter((choice) => choice.disabled).map((choice) => choice.name);
    const names = choices.map((choice) => choice.name);

    expect(headers).toEqual([
      '── 🧭 Navigate ──',
      '── 🔍 Understand ──',
      '── 🔗 Relations ──',
      '── 📐 Workspace ──',
      '── 💾 Output ──',
      '── ⚙ Session ──',
    ]);
    expect(names.some((name) => name.startsWith('/scope'))).toBe(true);
    expect(names.some((name) => name.startsWith('/quit'))).toBe(true);
    expect(names.some((name) => name.startsWith('/command'))).toBe(false);
  });

  it('finds /scope from the old /path name', () => {
    const choices = buildMainActionChoices('/path');

    expect(choices.some((choice) => choice.name.startsWith('/scope'))).toBe(true);
    expect(choices.find((choice) => choice.name.startsWith('/scope'))?.value).toEqual({ kind: 'action', action: 'setPath' });
  });
});
