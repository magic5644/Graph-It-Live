/** CLI command for deterministic, token-bounded graph context retrieval. */

import { executeGraphContext } from '../../mcp/tools/index.js';
import { GraphContextParamsSchema, type GraphContextParams } from '../../mcp/types.js';
import { CliError, ExitCode } from '../errors.js';
import type { CliOutputFormat } from '../formatter.js';
import { formatOutput } from '../formatter.js';
import type { CliRuntime } from '../runtime.js';
import { projectGraphContextOutput } from '../../shared/graph-context-output.js';

const VALUE_FLAGS = new Set([
  '--mode', '--scope', '--depth', '--max-nodes', '--token-budget', '--from', '--to',
  '--seeds', '--relations', '--cursor', '--format', '--workspace', '-w',
  '--detail',
]);
const BOOLEAN_FLAGS = new Set(['--directed']);

function value(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

function numberValue(args: string[], flag: string): number | undefined {
  const raw = value(args, flag);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) throw new CliError(`${flag} must be an integer`, ExitCode.GENERAL_ERROR);
  return parsed;
}

function values(args: string[], flag: string): string[] {
  return args.flatMap((arg, index) => arg === flag ? [args[index + 1]] : []);
}

function seed(raw: string): NonNullable<GraphContextParams['from']> {
  const separator = raw.indexOf('#');
  if (separator < 0) return { symbolName: raw };
  const filePath = raw.slice(0, separator);
  const symbolName = raw.slice(separator + 1);
  if (!filePath || !symbolName) throw new CliError('Endpoint must use <file>#<symbol>', ExitCode.GENERAL_ERROR);
  return { filePath, symbolName };
}

function parse(args: string[], format: CliOutputFormat): GraphContextParams {
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('-')) {
      positionals.push(arg);
      continue;
    }
    if (BOOLEAN_FLAGS.has(arg)) continue;
    if (!VALUE_FLAGS.has(arg) || args[index + 1] === undefined || args[index + 1].startsWith('-')) {
      throw new CliError(`Invalid context option: ${arg}`, ExitCode.GENERAL_ERROR);
    }
    index += 1;
  }

  const requestedFormat = value(args, '--format') ?? (format === 'json' ? 'json' : 'toon');
  const seedValues = values(args, '--seeds');
  const relationValues = values(args, '--relations');
  const from = value(args, '--from');
  const to = value(args, '--to');
  const params: GraphContextParams = {
    question: positionals.length > 0 ? positionals.join(' ') : undefined,
    seeds: seedValues.length > 0 ? seedValues.map(seed) : undefined,
    mode: value(args, '--mode') as GraphContextParams['mode'],
    relations: relationValues.length > 0
      ? relationValues as NonNullable<GraphContextParams['relations']>
      : undefined,
    scope: value(args, '--scope'),
    depth: numberValue(args, '--depth'),
    maxNodes: numberValue(args, '--max-nodes'),
    tokenBudget: numberValue(args, '--token-budget'),
    from: from === undefined ? undefined : seed(from),
    to: to === undefined ? undefined : seed(to),
    directed: args.includes('--directed') || undefined,
    cursor: value(args, '--cursor'),
    format: requestedFormat as GraphContextParams['format'],
    detail: value(args, '--detail') as GraphContextParams['detail'],
  };
  const result = GraphContextParamsSchema.safeParse(params);
  if (!result.success) throw new CliError(result.error.message, ExitCode.GENERAL_ERROR);
  return result.data;
}

export async function run(args: string[], runtime: CliRuntime, format: CliOutputFormat): Promise<string> {
  const params = parse(args, format);
  await runtime.ensureIndexed();
  const response = await executeGraphContext(params);
  return formatOutput(projectGraphContextOutput(response, params.detail), format === 'markdown' || format === 'mermaid' ? 'json' : format, 'context');
}
