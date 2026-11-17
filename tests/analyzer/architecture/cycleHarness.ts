import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildArchitectureGraph, type ArchitectureGraph } from "@/analyzer/architecture/ArchitectureGraphBuilder";
import { assessArchitecture, type ArchitectureAssessment, type AssessmentInput } from "@/analyzer/architecture/architectureAssessment";
import { unitMatrix } from "@/analyzer/architecture/architectureMatrix";
import { assignUnits, buildArchitectureUnits } from "@/analyzer/architecture/architectureUnits";
import { SpiderBuilder } from "@/analyzer/SpiderBuilder";
import { renderInitText, type InitResult } from "@/cli/commands/initReport";

/** The cycle fixtures of #740 and #741: a real workspace on disk, analysed as `graph-it init` does. */
const roots: string[] = [];

export async function assessWorkspace(files: Record<string, string>): Promise<{ root: string; graph: ArchitectureGraph; assessment: ArchitectureAssessment }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-it-cycles-"));
  roots.push(root);
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
  const spider = new SpiderBuilder().withRootDir(root).withExcludeNodeModules(true).build();
  const graph = await buildArchitectureGraph(root, (file) => spider.analyze(file));
  const assignment = assignUnits(root, graph.nodes.map((node) => node.relativePath));
  const units = buildArchitectureUnits(graph, root, assignment);
  const input: AssessmentInput = { graph, units, unitOf: assignment.unitOf, matrix: unitMatrix(units), deadCode: [], acceptedViolations: 0 };
  return { root, graph, assessment: assessArchitecture(input) };
}

/** Call in afterEach. */
export function removeWorkspaces(): void {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
}

/** `a -> b`, with ` (type)` and ` (dynamic)` flags, sorted. */
export const edgeFlags = (graph: Pick<ArchitectureGraph, "edges">) =>
  graph.edges.map((edge) => `${edge.sourceRelative} -> ${edge.targetRelative}${edge.typeOnly ? " (type)" : ""}${edge.dynamic ? " (dynamic)" : ""}`).sort((left, right) => left.localeCompare(right));

export const cycleWins = (assessment: ArchitectureAssessment) =>
  assessment.quickWins.filter((win) => win.kind === "mutual-import" || win.kind === "cycle-break").map((win) => win.kind);

/** The text report of a dry-run init over the assessment. */
export const renderDryRun = (assessment: ArchitectureAssessment) => renderInitText({
  configFile: "graphit.architecture.json", baselineFile: "graphit.architecture.baseline.json", status: "dry-run",
  written: [], reportFiles: [], changes: [], acceptedViolations: 0,
  guard: { preCommit: "", ci: "", sarif: "" }, assessment, diagrams: [],
} satisfies InitResult);
