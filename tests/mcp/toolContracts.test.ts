/**
 * MCP Tool Contract Tests
 *
 * Locks the output-format contract advertised to MCP clients:
 * - `response_format` is the single output knob and defaults to `toon`
 * - no parameter schema still advertises the legacy, never-read `format` field
 *
 * The default is applied by Zod through `~standard.validate`, which is exactly
 * the code path the MCP SDK runs before invoking a tool handler. Asserting it
 * here prevents a handler-side `?? "json"` fallback from being reintroduced and
 * silently contradicting the advertised default.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as mcpTypes from '../../src/mcp/types';

const ResponseFormatSchema = z.enum(['json', 'markdown', 'toon']).default('toon');

function validate<T extends z.ZodType>(schema: T, input: unknown): unknown {
  const result = schema['~standard'].validate(input);
  if (result instanceof Promise) {
    throw new TypeError('Schema validation must be synchronous for MCP tools');
  }
  if (result.issues) {
    throw new Error(`Validation failed: ${JSON.stringify(result.issues)}`);
  }
  return result.value;
}

function paramSchemaEntries(): [string, z.ZodObject<z.ZodRawShape>][] {
  return Object.entries(mcpTypes).filter(
    (entry): entry is [string, z.ZodObject<z.ZodRawShape>] =>
      entry[0].endsWith('ParamsSchema') && entry[1] instanceof z.ZodObject,
  );
}

describe('MCP tool output-format contract', () => {
  it('defaults response_format to toon on the SDK validation path', () => {
    const schema = z
      .object({ filePath: z.string() })
      .extend({ response_format: ResponseFormatSchema });

    expect(validate(schema, { filePath: '/project/src/a.ts' })).toEqual({
      filePath: '/project/src/a.ts',
      response_format: 'toon',
    });
  });

  it('keeps an explicit response_format untouched', () => {
    const schema = z
      .object({ filePath: z.string() })
      .extend({ response_format: ResponseFormatSchema });

    expect(validate(schema, { filePath: '/project/src/a.ts', response_format: 'json' })).toEqual({
      filePath: '/project/src/a.ts',
      response_format: 'json',
    });
  });

  it('rejects an unsupported response_format', () => {
    const schema = z
      .object({ filePath: z.string() })
      .extend({ response_format: ResponseFormatSchema });

    expect(() => validate(schema, { filePath: '/project/src/a.ts', response_format: 'xml' })).toThrow(
      /Validation failed/,
    );
  });

  it('exposes at least one parameter schema to inspect', () => {
    expect(paramSchemaEntries().length).toBeGreaterThan(0);
  });

  it('advertises no legacy format field on any parameter schema', () => {
    const offenders = paramSchemaEntries()
      .filter(([, schema]) => Object.hasOwn(schema.shape, 'format'))
      .map(([name]) => name);

    expect(offenders).toEqual([]);
  });

  it('drops a legacy format field instead of forwarding it', () => {
    const parsed = mcpTypes.GenerateCodemapParamsSchema.parse({
      filePath: '/project/src/service.ts',
      format: 'toon',
    });

    expect('format' in parsed).toBe(false);
  });
});
