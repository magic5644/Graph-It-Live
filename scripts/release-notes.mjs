import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Builds the GitHub release body for a tag: the matching changelog.md section,
// the PRs merged since the previous tag grouped by Conventional Commit type
// (breaking changes first), then the compare link.
// Usage: node scripts/release-notes.mjs <tag> <output-file>

const GROUPS = [
  ['breaking', 'Breaking changes'],
  ['feat', 'Features'],
  ['fix', 'Fixes'],
  ['perf', 'Performance'],
  ['refactor', 'Refactoring'],
  ['docs', 'Documentation'],
  ['test', 'Tests'],
  ['ci', 'CI'],
  ['chore', 'Chores / dependencies'],
  ['other', 'Other changes'],
];
const TYPE_ALIASES = { build: 'chore', deps: 'chore' };
const TITLE_PATTERN = /^(\w+)(?:\([^)]*\))?(!)?:/;
const BREAKING_FOOTER = /^BREAKING[ -]CHANGE:/m;

export function changelogSection(changelog, version) {
  const lines = changelog.split(/\r?\n/);
  const heading = `## v${version}`;
  const start = lines.findIndex((line) => line.trim() === heading || line.startsWith(`${heading} `));
  if (start === -1) {
    throw new Error(`changelog.md has no "${heading}" section`);
  }
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  return lines.slice(start + 1, end === -1 ? undefined : end).join('\n').trim();
}

function isBot(author) {
  const login = author?.login ?? '';
  return author?.is_bot === true || login.startsWith('app/') || login.endsWith('[bot]');
}

export function prGroup(pr) {
  const match = TITLE_PATTERN.exec(pr.title);
  if (match?.[2] || BREAKING_FOOTER.test(pr.body ?? '')) {
    return 'breaking';
  }
  if (isBot(pr.author)) {
    return 'chore';
  }
  const type = match ? (TYPE_ALIASES[match[1]] ?? match[1]) : 'other';
  return GROUPS.some(([key]) => key === type) ? type : 'other';
}

export function buildReleaseNotes({ changelog, tag, previousTag, repo, prs }) {
  const parts = [changelogSection(changelog, tag.replace(/^v/, ''))];
  if (prs.length > 0) {
    parts.push("## What's Changed");
    const sorted = [...prs].sort((a, b) => a.number - b.number);
    const login = (pr) => (pr.author?.login ?? 'ghost').replace(/^app\//, '');
    for (const [key, title] of GROUPS) {
      const items = sorted.filter((pr) => prGroup(pr) === key);
      if (items.length > 0) {
        parts.push(`### ${title}\n${items.map((pr) => `- ${pr.title} by @${login(pr)} in ${pr.url}`).join('\n')}`);
      }
    }
    const contributors = [...new Set(sorted.filter((pr) => !isBot(pr.author)).map(login))].sort((a, b) =>
      a.localeCompare(b),
    );
    if (contributors.length > 0) {
      parts.push(`## Contributors\nThanks to ${contributors.map((name) => `@${name}`).join(', ')}.`);
    }
  }
  if (previousTag) {
    parts.push(`**Full Changelog**: https://github.com/${repo}/compare/${previousTag}...${tag}`);
  }
  return `${parts.join('\n\n')}\n`;
}

function run(command, args) {
  return execFileSync(command, args, { encoding: 'utf8' }).trim();
}

function tryRun(command, args) {
  try {
    return run(command, args);
  } catch {
    return undefined;
  }
}

function mergedPrs(repo, ref, previousTag) {
  if (!previousTag) {
    return [];
  }
  const commits = new Set(run('git', ['rev-list', `${previousTag}..${ref}`]).split('\n'));
  const since = run('git', ['log', '-1', '--format=%cs', previousTag]);
  const prs = JSON.parse(run('gh', [
    'pr', 'list', '--repo', repo, '--state', 'merged', '--limit', '1000',
    '--search', `merged:>=${since}`,
    '--json', 'number,title,body,author,url,mergeCommit',
  ]));
  return prs.filter((pr) => commits.has(pr.mergeCommit?.oid));
}

function main([tag, output]) {
  if (!tag || !output) {
    throw new Error('Usage: node scripts/release-notes.mjs <tag> <output-file>');
  }
  const repo = process.env.GITHUB_REPOSITORY ?? run('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']);
  // A manual run may release a tag that does not exist yet: it is cut from HEAD.
  const ref = tryRun('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`]) ? tag : 'HEAD';
  const previousTag = tryRun('git', ['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*', `${ref}^`]);
  const notes = buildReleaseNotes({
    changelog: readFileSync('changelog.md', 'utf8'),
    tag,
    previousTag,
    repo,
    prs: mergedPrs(repo, ref, previousTag),
  });
  writeFileSync(output, notes);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exit(1);
  }
}
