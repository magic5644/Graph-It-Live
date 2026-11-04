export const MARKER = "<!-- graph-it-review-gate -->";
const MAX_ROWS = 20;
const MAX_CYCLE_FILES = 10;

export function sanitize(value) {
  return String(value ?? "").replace(/[\r\n|<>]/g, " ").replaceAll("`", "'").trim();
}

function safeScore(value) {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : 0;
}

function safeCount(value) {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

const list = (value) => (Array.isArray(value) ? value : []);

/** `rule: source:line -> target`, one import of a violation or a unit cycle. */
function violationLine(rule, violation) {
  const line = Number.isInteger(violation?.line) ? `:${violation.line}` : "";
  return `- ${sanitize(rule)}: ${sanitize(violation?.source)}${line} -> ${sanitize(violation?.target)}`;
}

function capped(title, lines) {
  if (lines.length === 0) return [];
  const more = lines.length > MAX_ROWS ? [`- … ${lines.length - MAX_ROWS} more`] : [];
  return ["", title, ...lines.slice(0, MAX_ROWS), ...more];
}

/** What a rules-file edit changes, one line per kind; `architecture.configChange` is absent when the diff leaves them alone. */
function configChangeLines(change) {
  if (!change || typeof change !== "object") return [];
  const names = (what, changes) => ["added", "removed", "changed"]
    .filter((kind) => list(changes?.[kind]).length > 0)
    .map((kind) => `- ${what} ${kind}: ${list(changes[kind]).map(sanitize).join(", ")}`);
  const baseline = list(change.baseline?.added).length + list(change.baseline?.removed).length > 0
    ? [`- Baseline: ${list(change.baseline?.added).length} violation(s) accepted, ${list(change.baseline?.removed).length} entry(ies) removed`]
    : [];
  return ["", "#### Architecture rules or baseline changed", ...names("Rules", change.rules), ...names("Elements", change.elements),
    ...(change.roles ? ["- Unit roles changed"] : []), ...baseline];
}

/** The architecture section; `architecture` is absent without graphit.architecture.json or from an older CLI. */
function architectureLines(architecture) {
  if (!architecture || typeof architecture !== "object") return [];
  const rules = list(architecture.rules);
  const rows = rules.map((rule) =>
    `| ${sanitize(rule?.name)} | ${sanitize(rule?.severity)} | ${list(rule?.newViolations).length} | ${list(rule?.resolvedViolations).length} | ${safeCount(rule?.unchanged)} |`);
  const added = rules.flatMap((rule) => list(rule?.newViolations).map((violation) =>
    `${violationLine(rule?.name, violation)}${violation?.accepted ? " (accepted by the baseline)" : ""}`));
  const resolved = rules.flatMap((rule) => list(rule?.resolvedViolations).map((violation) => violationLine(rule?.name, violation)));
  const cycles = architecture.unitCycles;
  return [
    "", `### Architecture rules: ${sanitize(architecture.verdict).toUpperCase()}`,
    "",
    `New error violations: ${safeCount(architecture.newErrors)}. Unit cycles: ${list(cycles?.newViolations).length} new, ${list(cycles?.resolvedViolations).length} resolved, ${safeCount(cycles?.unchanged)} unchanged.`,
    ...(rows.length > 0 ? ["", "| Rule | Severity | New | Resolved | Unchanged |", "| --- | --- | ---: | ---: | ---: |", ...rows] : []),
    ...capped("#### New violations", added),
    ...capped("#### Resolved violations", resolved),
    ...capped("#### New unit cycles", list(cycles?.newViolations).map((violation) => violationLine("units", violation))),
    ...configChangeLines(architecture.configChange),
  ];
}

export function buildReviewDeepLink(result, extensionId = "magic5644.graph-it-live") {
  const symbols = Array.isArray(result?.symbols) ? result.symbols : [];
  const target = symbols.find((symbol) =>
    typeof symbol?.filePath === "string" && symbol.filePath.length > 0 &&
    typeof symbol?.name === "string" && symbol.name.length > 0,
  );
  if (!target) return undefined;
  const params = new URLSearchParams({ file: target.filePath, symbol: target.name, depth: "3" });
  return `vscode://${extensionId}/graph-it-live.reviewCallGraph?${params.toString()}`;
}

export function findStickyComment(comments, marker = MARKER) {
  return Array.isArray(comments)
    ? comments.find((comment) => comment?.user?.type === "Bot" && typeof comment.body === "string" && comment.body.includes(marker))
    : undefined;
}

/**
 * `endpoint` lists and creates comments on one pull request:
 * `/repos/{owner}/{repo}/issues/{number}/comments`. A comment is updated at
 * `/repos/{owner}/{repo}/issues/comments/{id}`, without the number: appending the
 * id to `endpoint` returned 404, and the 404 fallback posted a new comment on
 * every run instead of updating the sticky one.
 */
export function getCommentUpsert(endpoint, existing) {
  return {
    method: existing ? "PATCH" : "POST",
    url: existing ? `${endpoint.replace(/\/\d+\/comments$/, "/comments")}/${existing.id}` : endpoint,
    operation: existing ? "update comment" : "create comment",
  };
}

export async function upsertReviewComment(fetchImpl, endpoint, headers, existing, body) {
  const update = getCommentUpsert(endpoint, existing);
  try {
    return await fetchJsonOrThrow(fetchImpl, update.url, { method: update.method, headers, body: JSON.stringify({ body }) }, update.operation);
  } catch (error) {
    if (update.method !== "PATCH" || error?.status !== 404) throw error;
    const create = getCommentUpsert(endpoint, undefined);
    return fetchJsonOrThrow(fetchImpl, create.url, { method: create.method, headers, body: JSON.stringify({ body }) }, create.operation);
  }
}

export function renderReviewComment(result, extensionId) {
  const symbols = Array.isArray(result?.symbols) ? result.symbols : [];
  const limitations = Array.isArray(result?.limitations) ? result.limitations : [];
  const changedFiles = Array.isArray(result?.changedFiles) ? result.changedFiles : [];
  const rows = symbols.slice(0, MAX_ROWS).map((symbol) => {
    const cycleCount = Array.isArray(symbol?.cycleEvidence) ? symbol.cycleEvidence.length : 0;
    return `| ${sanitize(symbol?.risk)} | ${safeScore(symbol?.score)} | ${sanitize(symbol?.filePath)} | ${sanitize(symbol?.name)} | ${sanitize(symbol?.impactedSymbolCount)} | ${sanitize(cycleCount)} | ${sanitize(symbol?.unusedExportEvidence ? "yes" : "no")} |`;
  });
  const limitationLines = limitations.map((item) => `- ${sanitize(item)}`);
  const evidence = symbols.slice(0, MAX_ROWS).flatMap((symbol) =>
    (Array.isArray(symbol?.evidence) ? symbol.evidence : []).map((item) => `- ${sanitize(symbol?.filePath)}:${sanitize(symbol?.name)} — ${sanitize(item?.detail)}`),
  );
  // `cycles` is absent from the JSON of an older CLI.
  const cycleLines = (Array.isArray(result?.cycles) ? result.cycles : []).slice(0, MAX_ROWS).map((cycle) => {
    const files = Array.isArray(cycle?.files) ? cycle.files : [];
    const more = files.length > MAX_CYCLE_FILES ? `, +${files.length - MAX_CYCLE_FILES} more` : "";
    return `- ${sanitize(cycle?.classification)}: ${files.slice(0, MAX_CYCLE_FILES).map(sanitize).join(", ")}${more}`;
  });
  const deepLink = buildReviewDeepLink(result, extensionId);
  return [
    MARKER,
    `## Graph-It Review Gate: ${sanitize(result?.risk).toUpperCase()} (${safeScore(result?.score)}/100)`,
    "",
    `Changed files: ${safeScore(changedFiles.length)}. ${result?.isPartial ? "Partial analysis; see limitations." : "Complete within configured limits."}`,
    "",
    "| Risk | Score | File | Symbol | Dependents | Cycles | Unused export |",
    "| --- | ---: | --- | --- | ---: | ---: | --- |",
    ...(rows.length > 0 ? rows : ["| low | 0 | — | No risky changed symbols detected | 0 | 0 | no |"]),
    ...(evidence.length > 0 ? ["", "### Evidence", ...evidence] : []),
    ...(cycleLines.length > 0 ? ["", "### Import cycles", ...cycleLines] : []),
    ...architectureLines(result?.architecture),
    ...(limitationLines.length > 0 ? ["", "### Limitations", ...limitationLines] : []),
    // GitHub strips non-http(s) links from comments, so the URI is a code span to copy, not a Markdown link.
    ...(deepLink ? ["", "Open the highest-risk call graph: copy this URI and paste it in your browser address bar (VS Code with Graph-It-Live must be installed).", "", `\`${deepLink}\``] : []),
  ].join("\n");
}

export async function fetchJsonOrThrow(fetchImpl, url, options, operation) {
  const response = await fetchImpl(url, options);
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : undefined; } catch { data = text; }
  if (!response.ok) {
    const detail = typeof data === "object" && data?.message ? data.message : sanitize(text).slice(0, 300);
    const error = new Error(`GitHub ${operation} failed (${response.status}): ${detail || response.statusText}`);
    error.status = response.status;
    throw error;
  }
  return data;
}
