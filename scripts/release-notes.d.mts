export interface ReleasePr {
  number: number;
  title: string;
  body?: string;
  author?: { login?: string; is_bot?: boolean };
  url: string;
}

export function changelogSection(changelog: string, version: string): string;
export function prGroup(pr: ReleasePr): string;
export function buildReleaseNotes(options: {
  changelog: string;
  tag: string;
  previousTag: string | undefined;
  repo: string;
  prs: ReleasePr[];
}): string;
