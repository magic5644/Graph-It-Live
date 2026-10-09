/**
 * Release notes builder tests
 *
 * scripts/release-notes.mjs builds the GitHub release body: the changelog.md
 * section of the tag, then merged PRs grouped by Conventional Commit type
 * (breaking changes first), then the compare link.
 */

import { describe, expect, it } from 'vitest';
import { buildReleaseNotes, changelogSection, prGroup } from '../../scripts/release-notes.mjs';

const changelog = ['# Changelog', '## v1.2.0', '### Fixed', '- Fixed a thing.', '## v1.1.0', '- Older.'].join('\n');
const human = { login: 'alice', is_bot: false };
const pr = (number: number, title: string, extra: Record<string, unknown> = {}) => ({
  number,
  title,
  body: '',
  author: human,
  url: `https://github.com/o/r/pull/${number}`,
  ...extra,
});

describe('changelogSection', () => {
  it('returns the section body up to the next version heading', () => {
    expect(changelogSection(changelog, '1.2.0')).toBe('### Fixed\n- Fixed a thing.');
    expect(changelogSection(changelog, '1.1.0')).toBe('- Older.');
  });

  it('handles CRLF line endings', () => {
    expect(changelogSection(changelog.replaceAll('\n', '\r\n'), '1.2.0')).toBe('### Fixed\n- Fixed a thing.');
  });

  it('throws when the version section is missing', () => {
    expect(() => changelogSection(changelog, '1.3.0')).toThrow('changelog.md has no "## v1.3.0" section');
    expect(() => changelogSection(changelog, '1.2')).toThrow('## v1.2"');
  });
});

describe('prGroup', () => {
  it('groups by Conventional Commit type, with or without scope', () => {
    expect(prGroup(pr(1, 'feat: add x'))).toBe('feat');
    expect(prGroup(pr(2, 'fix(cli): repair y'))).toBe('fix');
    expect(prGroup(pr(3, 'build(deps): bump z'))).toBe('chore');
    expect(prGroup(pr(4, 'Update README'))).toBe('other');
    expect(prGroup(pr(5, 'style: format'))).toBe('other');
  });

  it('marks `!` titles and BREAKING CHANGE footers as breaking', () => {
    expect(prGroup(pr(1, 'feat(api)!: drop v1'))).toBe('breaking');
    expect(prGroup(pr(2, 'refactor!: rename'))).toBe('breaking');
    expect(prGroup(pr(3, 'fix: x', { body: 'Details\n\nBREAKING CHANGE: flag removed' }))).toBe('breaking');
    expect(prGroup(pr(4, 'fix: x', { body: 'BREAKING-CHANGE: flag removed' }))).toBe('breaking');
    expect(prGroup(pr(5, 'fix: x', { body: 'not a BREAKING CHANGE: inline' }))).toBe('fix');
  });

  it('files bot PRs under chores whatever their type', () => {
    expect(prGroup(pr(1, 'fix(deps): bump a', { author: { login: 'app/dependabot', is_bot: true } }))).toBe('chore');
    expect(prGroup(pr(2, 'feat: sync', { author: { login: 'renovate[bot]' } }))).toBe('chore');
  });
});

describe('buildReleaseNotes', () => {
  it('starts with the changelog section, lists breaking changes first, ends with the compare link', () => {
    const notes = buildReleaseNotes({
      changelog,
      tag: 'v1.2.0',
      previousTag: 'v1.1.0',
      repo: 'o/r',
      prs: [
        pr(12, 'fix: b'),
        pr(10, 'docs: c'),
        pr(11, 'fix: a'),
        pr(13, 'feat!: d'),
        pr(14, 'chore(deps): e', { author: { login: 'app/dependabot', is_bot: true } }),
      ],
    });

    expect(notes).toBe(
      [
        '### Fixed\n- Fixed a thing.',
        "## What's Changed",
        '### Breaking changes\n- feat!: d by @alice in https://github.com/o/r/pull/13',
        '### Fixes\n- fix: a by @alice in https://github.com/o/r/pull/11\n- fix: b by @alice in https://github.com/o/r/pull/12',
        '### Documentation\n- docs: c by @alice in https://github.com/o/r/pull/10',
        '### Chores / dependencies\n- chore(deps): e by @dependabot in https://github.com/o/r/pull/14',
        '## Contributors\nThanks to @alice.',
        '**Full Changelog**: https://github.com/o/r/compare/v1.1.0...v1.2.0',
      ].join('\n\n') + '\n',
    );
  });

  it('credits each human author once, sorted, and never bots', () => {
    const notes = buildReleaseNotes({
      changelog,
      tag: 'v1.2.0',
      previousTag: 'v1.1.0',
      repo: 'o/r',
      prs: [
        pr(1, 'fix: a', { author: { login: 'zoe' } }),
        pr(2, 'fix: b'),
        pr(3, 'feat: c', { author: { login: 'zoe' } }),
        pr(4, 'chore: d', { author: { login: 'github-actions[bot]', is_bot: true } }),
      ],
    });

    expect(notes).toContain('## Contributors\nThanks to @alice, @zoe.\n\n**Full Changelog**');
  });

  it('omits the PR list and compare link when there is nothing to show', () => {
    expect(buildReleaseNotes({ changelog, tag: 'v1.1.0', previousTag: undefined, repo: 'o/r', prs: [] })).toBe(
      '- Older.\n',
    );
  });

  it('fails when the changelog has no section for the tag', () => {
    expect(() => buildReleaseNotes({ changelog, tag: 'v9.9.9', previousTag: 'v1.2.0', repo: 'o/r', prs: [] })).toThrow(
      'no "## v9.9.9" section',
    );
  });
});
