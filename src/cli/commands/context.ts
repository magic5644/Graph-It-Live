/** CLI command for deterministic, token-bounded graph context retrieval. */

import { executeGraphContext } from '../../mcp/tools/index.js';
import { GraphContextParamsSchema, type GraphContextParams } from '../../mcp/types.js';
import { CliError, ExitCode } from '../errors.js';
import type { CliOutputFormat } from '../formatter.js';
import { formatOutput } from '../formatter.js';
import type { CliRuntime } from '../runtime.js';

const VALUE_FLAGS = new Set(['--mode', '--scope', '--depth', '--max-nodes', '--token-budget', '--from', '--to', '--format']);

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

function seed(raw: string | undefined): GraphContextParams['from'] {
  if (raw === undefined) return undefined;
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
    if (!VALUE_FLAGS.has(arg) || args[index + 1] === undefined || args[index + 1].startsWith('-')) {
      throw new CliError(`Invalid context option: ${arg}`, ExitCode.GENERAL_ERROR);
    }
    index += 1;
  }

  const requestedFormat = value(args, '--format') ?? (format === 'json' ? 'json' : 'toon');
  const params: GraphContextParams = {
    question: positionals.length > 0 ? positionals.join(' ') : undefined,
    mode: value(args, '--mode') as GraphContextParams['mode'],
    scope: value(args, '--scope'),
    depth: numberValue(args, '--depth'),
    maxNodes: numberValue(args, '--max-nodes'),
    tokenBudget: numberValue(args, '--token-budget'),
    from: seed(value(args, '--from')),
    to: seed(value(args, '--to')),
    format: requestedFormat as GraphContextParams['format'],
  };
  const result = GraphContextParamsSchema.safeParse(params);
  if (!result.success) throw new CliError(result.error.message, ExitCode.GENERAL_ERROR);
  return result.data;
}

export async function run(args: string[], runtime: CliRuntime, format: CliOutputFormat): Promise<string> {
  const params = parse(args, format);
  await runtime.ensureIndexed();
  return formatOutput(await executeGraphContext(params), format === 'markdown' || format === 'mermaid' ? 'json' : format, 'context');
}
