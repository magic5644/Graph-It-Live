#!/usr/bin/env node
/**
 * Runs a fixed local-analysis corpus in JSON and TOON formats.
 *
 * The runner explicitly removes LLM credentials from child processes. It keeps
 * raw output and a machine-readable report so the encoding estimate is never
 * confused with actual provider token usage.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { estimateTokenSavings } from "../src/shared/toon.ts";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const workspaceRoot = resolve(process.argv[2] ?? repoRoot);
const outputRoot = resolve(process.argv[3] ?? join(repoRoot, ".reports", "context-economy"));
const cliPath = join(repoRoot, "dist", "graph-it.js");

if (!existsSync(cliPath)) {
  throw new Error("Missing dist/graph-it.js. Run npm run build:cli before this corpus.");
}

const runId = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const runDir = join(outputRoot, runId);
const statsHome = mkdtempSync(join(tmpdir(), "graph-it-context-economy-"));
const statsDir = join(statsHome, ".graph-it", "stats");
const queryFile = join(workspaceRoot, "src", "analyzer", "QueryEngine.ts");

const corpus = [
  { name: "architecture", args: ["architecture", "--maxFiles", "10"] },
  { name: "codemap", args: ["tool", "generate_codemap", `--filePath=${queryFile}`] },
  { name: "impact", args: ["tool", "get_impact_analysis", `--filePath=${queryFile}`, "--symbolName=query"] },
  { name: "call-graph", args: ["tool", "query_call_graph", `--filePath=${queryFile}`, "--symbolName=query"] },
];

function createChildEnv() {
  const env = { ...process.env, HOME: statsHome };
  delete env.ANTHROPIC_API_KEY;
  delete env.OPENAI_API_KEY;
  delete env.OPENAI_BASE_URL;
  delete env.OPENAI_MODEL;
  delete env.GRAPH_IT_NO_STATS;
  return env;
}

function runAnalysis(entry, format) {
  const output = execFileSync(
    process.execPath,
    [cliPath, `--workspace=${workspaceRoot}`, `--format=${format}`, ...entry.args],
    { cwd: workspaceRoot, env: createChildEnv(), encoding: "utf8", maxBuffer: 20 * 1024 * 1024 },
  );
  const extension = format === "json" ? "json" : "toon";
  const relativePath = join(format, `${entry.name}.${extension}`);
  const absolutePath = join(runDir, relativePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, output, "utf8");
  return { relativePath, output };
}

function measureEncoding(jsonOutput, toonOutput) {
  const estimates = estimateTokenSavings(jsonOutput, toonOutput);
  return {
    jsonBytes: Buffer.byteLength(jsonOutput, "utf8"),
    toonBytes: Buffer.byteLength(toonOutput, "utf8"),
    jsonChars: jsonOutput.length,
    toonChars: toonOutput.length,
    ...estimates,
  };
}

try {
  mkdirSync(runDir, { recursive: true });
  const runs = corpus.map((entry) => {
    const json = runAnalysis(entry, "json");
    const toon = runAnalysis(entry, "toon");
    return {
      analysis: entry.name,
      rawOutputs: { json: json.relativePath, toon: toon.relativePath },
      encodingEstimate: measureEncoding(json.output, toon.output),
      llmUsage: { calls: 0, tokensUsed: 0 },
    };
  });

  const snapshots = existsSync(statsDir)
    ? readdirSync(statsDir).filter((file) => file.endsWith(".json")).map((file) =>
      JSON.parse(readFileSync(join(statsDir, file), "utf8")),
    )
    : [];

  if (snapshots.some((snapshot) => snapshot.llmUsage?.calls !== 0 || snapshot.llmUsage?.tokensUsed !== 0)) {
    throw new Error("The local corpus recorded LLM usage; inspect the generated stats snapshots.");
  }

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    workspace: basename(workspaceRoot),
    corpus: corpus.map(({ name }) => name),
    llmCredentialsRemoved: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
    runs,
    totals: runs.reduce((totals, run) => ({
      jsonBytes: totals.jsonBytes + run.encodingEstimate.jsonBytes,
      toonBytes: totals.toonBytes + run.encodingEstimate.toonBytes,
      jsonChars: totals.jsonChars + run.encodingEstimate.jsonChars,
      toonChars: totals.toonChars + run.encodingEstimate.toonChars,
      jsonTokens: totals.jsonTokens + run.encodingEstimate.jsonTokens,
      toonTokens: totals.toonTokens + run.encodingEstimate.toonTokens,
      savings: totals.savings + run.encodingEstimate.savings,
    }), { jsonBytes: 0, toonBytes: 0, jsonChars: 0, toonChars: 0, jsonTokens: 0, toonTokens: 0, savings: 0 }),
    persistedStats: snapshots,
    notes: [
      "llmUsage is actual recorded provider usage, not an estimate.",
      "encodingEstimate uses estimateTokenSavings semantics: chars/4 rounded up.",
      "TOON size estimates do not claim provider billing-token savings.",
    ],
  };

  report.totals.savingsPercent = report.totals.jsonTokens === 0
    ? 0
    : (report.totals.savings / report.totals.jsonTokens) * 100;

  writeFileSync(join(runDir, "report.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log(`Context-economy corpus written to ${runDir}`);
  console.log(`Verified ${runs.length} analyses with llmUsage.calls = 0 and tokensUsed = 0.`);
} finally {
  rmSync(statsHome, { recursive: true, force: true });
}
