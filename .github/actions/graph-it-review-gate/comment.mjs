import { readFile } from "node:fs/promises";
import { fetchJsonOrThrow, findStickyComment, getCommentUpsert, renderReviewComment } from "./commentHelpers.mjs";

const eventPath = process.env.GITHUB_EVENT_PATH;
if (!process.env.REVIEW_FILE || !eventPath || !process.env.GITHUB_TOKEN || !process.env.GITHUB_REPOSITORY) {
	throw new Error("Missing required GitHub Action environment for review comment");
}
let result;
let event;
try {
	result = JSON.parse(await readFile(process.env.REVIEW_FILE, "utf8"));
	event = JSON.parse(await readFile(eventPath, "utf8"));
} catch (error) {
	throw new Error(`Invalid review report or GitHub event JSON: ${error instanceof Error ? error.message : String(error)}`);
}
const body = renderReviewComment(result, "magic5644.graph-it-live");
const pullNumber = event.pull_request?.number;
if (!pullNumber) process.exit(0);
const [owner, repo, ...extra] = process.env.GITHUB_REPOSITORY.split("/");
if (!owner || !repo || extra.length > 0 || !Number.isInteger(pullNumber) || pullNumber < 1) throw new Error("Invalid GitHub repository or pull request number");
const headers = { authorization: `Bearer ${process.env.GITHUB_TOKEN}`, accept: "application/vnd.github+json", "content-type": "application/json" };
const endpoint = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${pullNumber}/comments`;
const comments = await fetchJsonOrThrow(fetch, endpoint, { headers }, "list comments");
if (!Array.isArray(comments)) throw new Error("GitHub list comments returned an invalid response");
const existing = findStickyComment(comments);
const upsert = getCommentUpsert(endpoint, existing);
await fetchJsonOrThrow(fetch, upsert.url, { method: upsert.method, headers, body: JSON.stringify({ body }) }, upsert.operation);
