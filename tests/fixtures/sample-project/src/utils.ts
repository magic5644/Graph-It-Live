
import { circular } from './circular';
export function greet(name: string): string {
  return `Hello, ${name}!`;
}

export function add(a: number, b: number): number {
  circular();
  return a + b;
}
