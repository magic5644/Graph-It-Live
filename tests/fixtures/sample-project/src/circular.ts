// Circular dependency test
import { main } from './main';

export function circular() {
  return main;
}
