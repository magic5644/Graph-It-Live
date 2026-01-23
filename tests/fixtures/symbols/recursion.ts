/**
 * Test fixture for T057: Recursive calls with cycle detection
 * Contains functions with direct and indirect recursion
 */

// Direct recursion: fibonacci
export function fibonacci(n: number): number {
  if (n <= 1) return n;
  return fibonacci(n - 1) + fibonacci(n - 2); // Self-call creates cycle
}

// Direct recursion: factorial
export function factorial(n: number): number {
  if (n <= 1) return 1;
  return n * factorial(n - 1); // Self-call creates cycle
}

// Indirect recursion: isEven/isOdd
export function isEven(n: number): boolean {
  if (n === 0) return true;
  return isOdd(n - 1); // Calls isOdd
}

export function isOdd(n: number): boolean {
  if (n === 0) return false;
  return isEven(n - 1); // Calls isEven, creating mutual recursion cycle
}

// Tree traversal with recursion
interface TreeNode {
  value: number;
  left?: TreeNode;
  right?: TreeNode;
}

export function sumTree(node: TreeNode | undefined): number {
  if (!node) return 0;
  return node.value + sumTree(node.left) + sumTree(node.right); // Recursive calls
}
