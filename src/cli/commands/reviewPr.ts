import { ReviewGateAnalyzer, renderReviewMarkdown } from "../../analyzer/ReviewGateAnalyzer";
import { createSpiderDependentsProvider } from "../../mcp/tools/impact";
import { workerState } from "../../mcp/shared/state";
import { CliError, ExitCode } from "../errors";
import type { CliOutputFormat } from "../formatter";
import { formatOutput } from "../formatter";
import type { CliRuntime } from "../runtime";

/** Analyze the checked-out diff against a Git base ref. */
export async function run(args: string[], runtime: CliRuntime, format: CliOutputFormat): Promise<string> {
  const baseRef = readOption(args, "base");
  if (!baseRef) {
    throw new CliError("review-pr requires --base <git-ref>", ExitCode.GENERAL_ERROR);
  }
  const headRef = readOption(args, "head");
  const maxDepth = readIntegerOption(args, "depth");
  const maxFiles = readIntegerOption(args, "max-files");
  await runtime.ensureIndexed({ silent: true });
  const analyzer = new ReviewGateAnalyzer(runtime.workspaceRoot, createSpiderDependentsProvider(workerState.getSpider()));
  const result = await analyzer.analyze({ baseRef, headRef, maxDepth, maxFiles });
  return format === "markdown" ? renderReviewMarkdown(result) : formatOutput(result, format, "review-pr");
}

function readOption(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

function readIntegerOption(args: string[], name: string): number | undefined {
  const value = readOption(args, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new CliError(`--${name} must be an integer`, ExitCode.GENERAL_ERROR);
  }
  return parsed;
}
