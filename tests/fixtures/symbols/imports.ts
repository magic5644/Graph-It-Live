/**
 * Test fixture for T058b: External references with dimming (opacity: 0.5)
 * Contains imports from external modules
 */

// External module imports - should appear dimmed (opacity: 0.5) with dashed edges per FR-022
import { readFileSync } from 'node:fs'; // Node.js built-in
import { join, resolve } from 'node:path'; // Node.js built-in

// Local imports from same project - should NOT be dimmed
import { processData } from './callbacks';
import { fibonacci } from './recursion';

// External reference usage - these calls should appear with dashed edges
export function buildPath(base: string, relative: string): string {
  return join(base, relative); // External call to 'join' - dimmed
}

export function resolvePath(path: string): string {
  return resolve(path); // External call to 'resolve' - dimmed
}

export function readConfig(configPath: string): string {
  return readFileSync(configPath, 'utf-8'); // External call - dimmed
}

// Local calls - should NOT be dimmed, normal solid edges
export function calculateFib(n: number): number {
  return fibonacci(n); // Local call - normal style
}

export function transformData(items: number[]): number[] {
  return processData(items); // Local call - normal style
}

// Mixed: external + local calls in same function
export function complexOperation(base: string, items: number[]): number[] {
  const fullPath = resolve(base); // External - dimmed
  console.log(fullPath); // External (console.log) - dimmed
  return processData(items); // Local - normal
}
