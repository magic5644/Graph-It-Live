export const MARKER = "<!-- graph-it-review-gate -->";
const MAX_ROWS = 20;

export function sanitize(value) {
  return String(value ?? "").replace(/[\r\n|<>]/g, " ").replaceAll("`", "'").trim();
}

function safeScore(value) {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : 0;
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

export function findStickyComment(comments) {
  return Array.isArray(comments)
    ? comments.find((comment) => comment?.user?.type === "Bot" && typeof comment.body === "string" && comment.body.includes(MARKER))
    : undefined;
}

export function getCommentUpsert(endpoint, existing) {
  return {
    method: existing ? "PATCH" : "POST",
    url: existing ? `${endpoint}/${existing.id}` : endpoint,
    operation: existing ? "update comment" : "create comment",
  };
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
    ...(limitationLines.length > 0 ? ["", "### Limitations", ...limitationLines] : []),
    ...(deepLink ? ["", `[Open highest-risk call graph](${deepLink})`] : []),
  ].join("\n");
}

export async function fetchJsonOrThrow(fetchImpl, url, options, operation) {
  const response = await fetchImpl(url, options);
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : undefined; } catch { data = text; }
  if (!response.ok) {
    const detail = typeof data === "object" && data?.message ? data.message : sanitize(text).slice(0, 300);
    throw new Error(`GitHub ${operation} failed (${response.status}): ${detail || response.statusText}`);
  }
  return data;
}
