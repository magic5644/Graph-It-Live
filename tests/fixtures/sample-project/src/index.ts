import { greet, multiply, sum } from './utils';

export function main() {
  const result = sum(5, 3);
  const product = multiply(result, 2);
  greet('World');
  return product;
}
