/**
 * Test fixture for T056: Edge differentiation (solid for calls, dashed for references)
 * Contains function call hierarchies
 */

// Utility functions with call relationships
export function helperA(): string {
  return 'A';
}

export function helperB(): string {
  return 'B';
}

// Function that calls other functions (solid arrows for calls)
export function mainProcess(): string {
  const a = helperA(); // Call relationship - solid arrow
  const b = helperB(); // Call relationship - solid arrow
  return a + b;
}

// Function with reference (not call) - dashed arrow
export function getHelperReference(): () => string {
  return helperA; // Reference, not call - dashed arrow
}

// Async function calls
export async function asyncProcess(): Promise<string> {
  const result = await helperA(); // Call relationship
  return result;
}

// Nested calls
export function deepProcess(): string {
  return mainProcess(); // Calls mainProcess, which calls helperA and helperB
}

// Function with both calls and references
export function mixedUsage(): void {
  helperA(); // Direct call - solid arrow
  const ref = helperB; // Reference - dashed arrow
  ref(); // Call via reference
}
