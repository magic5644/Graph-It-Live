// Layer 4 - Deepest layer for deep call chain benchmarks
import { shared, helper } from '../shared';

export function layer4Func(input: string): string {
  return shared + helper + ':' + input;
}

export function layer4Compute(data: string): number {
  return (shared + helper + data).length;
}

export class Layer4Core {
  run(msg: string): string {
    return layer4Func('core:' + msg);
  }
}
