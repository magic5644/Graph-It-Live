/**
 * TOON (Token-Oriented Object Notation) Format
 * 
 * A compact serialization format designed to reduce token consumption
 * for large structured data in LLM contexts.
 * 
 * Format Structure:
 * - Header: objectName(key1,key2,key3)
 * - Data: One line per object: [value1,value2,value3]
 * - Arrays: Nested arrays joined with pipe | delimiter
 * 
 * Example:
 * ```
 * files(file,deps)
 * [main.ts,[fs|path]]
 * [utils.ts,[os]]
 * ```
 * 
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 * NO import * as vscode from 'vscode' allowed!
 */

/**
 * Options for TOON serialization
 */
export interface ToonOptions {
  /** Name of the object type (default: 'data') */
  objectName?: string;
  /** Whether to escape special characters (default: true) */
  escapeValues?: boolean;
}

/**
 * Escape special characters in TOON values
 * Escapes: commas, brackets, pipes
 */
function escapeValue(value: string): string {
  return value
    .replaceAll('\\', String.raw`\\`)   // Escape backslashes first
    .replaceAll(',', String.raw`\,`)     // Escape commas
    .replaceAll('[', String.raw`\[`)    // Escape left bracket
    .replaceAll(']', String.raw`\]`)    // Escape right bracket
    .replaceAll('|', String.raw`\|`);   // Escape pipe
}

/**
 * Unescape special characters in TOON values
 */
function unescapeValue(value: string): string {
  return value
    .replaceAll(String.raw`\|`, '|')    // Unescape pipe
    .replaceAll(String.raw`\]`, ']')    // Unescape right bracket
    .replaceAll(String.raw`\[`, '[')    // Unescape left bracket
    .replaceAll(String.raw`\,`, ',')     // Unescape commas
    .replaceAll(String.raw`\\`, '\\');  // Unescape backslashes last
}

/**
 * Convert any value to TOON string representation
 */
function valueToToon(value: unknown, options: ToonOptions): string {
  if (value === null || value === undefined) {
    return '';
  }

  if (Array.isArray(value)) {
    // Join array items with pipe delimiter
    return value.map(item => valueToToon(item, options)).join('|');
  }

  if (typeof value === 'object') {
    // Convert object to JSON string
    const jsonStr = JSON.stringify(value);
    return options.escapeValues ? escapeValue(jsonStr) : jsonStr;
  }

  // Primitive values (string, number, boolean)
  if (typeof value === 'string') {
    return options.escapeValues ? escapeValue(value) : value;
  }

  // Numbers and booleans can be safely converted (objects are already handled above)
  const strValue = String(value as string | number | boolean);
  return options.escapeValues ? escapeValue(strValue) : strValue;
}

/**
 * Check if a string contains unescaped pipe characters
 */
function hasUnescapedPipe(str: string): boolean {
  let escaped = false;
  
  // Using for-of loop with entries to track escape sequences
  for (const [, char] of Array.from(str).entries()) {
    if (escaped) {
      escaped = false;
    } else if (char === '\\') {
      escaped = true;
    } else if (char === '|') {
      return true;
    }
  }
  
  return false;
}

/**
 * Split string by unescaped pipe characters
 */
function splitByUnescapedPipe(str: string): string[] {
  const parts: string[] = [];
  let currentPart = '';
  let escaped = false;
  
  // Using for-of loop with entries to track escape sequences
  for (const [, char] of Array.from(str).entries()) {
    if (escaped) {
      currentPart += char;
      escaped = false;
    } else if (char === '\\') {
      currentPart += char;
      escaped = true;
    } else if (char === '|') {
      parts.push(currentPart);
      currentPart = '';
    } else {
      currentPart += char;
    }
  }
  
  parts.push(currentPart);
  return parts;
}

/**
 * Parse a single TOON value (non-array)
 */
function parseSingleValue(unescaped: string): unknown {
  // Try to parse as JSON (for objects)
  if (unescaped.startsWith('{') || unescaped.startsWith('[')) {
    try {
      return JSON.parse(unescaped);
    } catch {
      // Not valid JSON, return as string
      return unescaped;
    }
  }

  // Try to parse as number
  if (/^-?\d+\.?\d*$/.test(unescaped)) {
    return Number.parseFloat(unescaped);
  }

  // Try to parse as boolean
  if (unescaped === 'true') {
    return true;
  }
  if (unescaped === 'false') {
    return false;
  }

  // Return as string
  return unescaped;
}

/**
 * Parse TOON value back to original type
 */
function toonToValue(toonStr: string, options: ToonOptions): unknown {
  if (toonStr === '') {
    return '';  // Empty string is empty string, not null
  }

  // Check if it contains UNESCAPED pipes (array delimiter)
  if (hasUnescapedPipe(toonStr)) {
    // Split by unescaped pipes and recursively parse each part
    const parts = splitByUnescapedPipe(toonStr);
    return parts.map(item => toonToValue(item, { ...options, escapeValues: options.escapeValues }));
  }

  // Unescape the value
  const unescaped = options.escapeValues ? unescapeValue(toonStr) : toonStr;

  // Parse single value
  return parseSingleValue(unescaped);
}

/**
 * Convert a JSON array of objects to TOON format
 * 
 * @param data - Array of objects to convert
 * @param options - Serialization options
 * @returns TOON-formatted string
 * 
 * @example
 * ```typescript
 * const data = [
 *   { file: 'main.ts', deps: ['fs', 'path'] },
 *   { file: 'utils.ts', deps: ['os'] }
 * ];
 * const toon = jsonToToon(data, { objectName: 'files' });
 * // Returns:
 * // files(file,deps)
 * // [main.ts,[fs|path]]
 * // [utils.ts,[os]]
 * ```
 */
export function jsonToToon(data: unknown[], options: ToonOptions = {}): string {
  const opts: Required<ToonOptions> = {
    objectName: options.objectName ?? 'data',
    escapeValues: options.escapeValues ?? true,
  };

  // Empty array
  if (data.length === 0) {
    return `${opts.objectName}()\n`;
  }

  // Extract keys from the first object
  const firstItem = data[0];
  if (typeof firstItem !== 'object' || firstItem === null || Array.isArray(firstItem)) {
    throw new Error('TOON format requires an array of objects');
  }

  const keys = Object.keys(firstItem);
  
  // Build header
  const header = `${opts.objectName}(${keys.join(',')})`;
  
  // Build data lines
  const lines = data.map(item => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error('All items must be objects');
    }

    const values = keys.map(key => {
      const value = (item as Record<string, unknown>)[key];
      return valueToToon(value, opts);
    });

    return `[${values.join(',')}]`;
  });

  return [header, ...lines].join('\n');
}

/**
 * Parse TOON header line to extract keys
 */
function parseHeader(headerLine: string): string[] {
  const headerRegex = /^(\w+)\((.*)\)$/;
  const headerMatch = headerRegex.exec(headerLine);
  
  if (!headerMatch) {
    throw new Error(`Invalid TOON header: ${headerLine}`);
  }

  return headerMatch[2] ? headerMatch[2].split(',') : [];
}

/**
 * Split data line by unescaped commas
 */
function splitDataLine(content: string): string[] {
  const values: string[] = [];
  let currentValue = '';
  let escaped = false;
  
  // Using for-of loop with entries to track escape sequences
  for (const [, char] of Array.from(content).entries()) {
    if (escaped) {
      currentValue += char;
      escaped = false;
    } else if (char === '\\') {
      currentValue += char;
      escaped = true;
    } else if (char === ',') {
      values.push(currentValue);
      currentValue = '';
    } else {
      currentValue += char;
    }
  }
  
  // Add the last value
  values.push(currentValue);
  return values;
}

/**
 * Parse a single data line into an object
 */
function parseDataLine(line: string, keys: string[], options: Required<ToonOptions>, lineNumber: number): Record<string, unknown> {
  if (!line.startsWith('[') || !line.endsWith(']')) {
    throw new Error(`Invalid TOON data line: ${line}`);
  }

  const content = line.slice(1, -1); // Remove brackets
  const values = splitDataLine(content);

  // Check if number of values matches number of keys
  if (values.length !== keys.length) {
    throw new Error(
      `Value count mismatch at line ${lineNumber}: expected ${keys.length} values, got ${values.length}`
    );
  }

  // Build object
  const obj: Record<string, unknown> = {};
  for (let k = 0; k < keys.length; k++) {
    obj[keys[k]] = toonToValue(values[k], options);
  }

  return obj;
}

/**
 * Parse TOON format back to JSON array of objects
 * 
 * @param toonStr - TOON-formatted string
 * @param options - Parsing options
 * @returns Array of objects
 * 
 * @example
 * ```typescript
 * const toon = `files(file,deps)
 * [main.ts,[fs|path]]
 * [utils.ts,[os]]`;
 * const data = toonToJson(toon);
 * // Returns:
 * // [
 * //   { file: 'main.ts', deps: ['fs', 'path'] },
 * //   { file: 'utils.ts', deps: ['os'] }
 * // ]
 * ```
 */
export function toonToJson(toonStr: string, options: ToonOptions = {}): unknown[] {
  const opts: Required<ToonOptions> = {
    objectName: options.objectName ?? 'data',
    escapeValues: options.escapeValues ?? true,
  };

  const lines = toonStr.trim().split('\n');
  
  if (lines.length === 0) {
    return [];
  }

  // Parse header line
  const keys = parseHeader(lines[0]);
  
  // Empty dataset
  if (keys.length === 0) {
    return [];
  }

  // Parse data lines
  const result: unknown[] = [];
  
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    
    if (!line) {
      continue; // Skip empty lines
    }

    result.push(parseDataLine(line, keys, opts, i + 1));
  }

  return result;
}

/**
 * Estimate token savings when using TOON vs JSON
 * 
 * @param jsonStr - JSON string to compare
 * @param toonStr - TOON string to compare
 * @returns Object with token counts and savings percentage
 */
export function estimateTokenSavings(jsonStr: string, toonStr: string): {
  jsonTokens: number;
  toonTokens: number;
  savings: number;
  savingsPercent: number;
} {
  // Rough estimate: 1 token ≈ 4 characters
  const jsonTokens = Math.ceil(jsonStr.length / 4);
  const toonTokens = Math.ceil(toonStr.length / 4);
  const savings = jsonTokens - toonTokens;
  const savingsPercent = (savings / jsonTokens) * 100;

  return {
    jsonTokens,
    toonTokens,
    savings,
    savingsPercent,
  };
}
