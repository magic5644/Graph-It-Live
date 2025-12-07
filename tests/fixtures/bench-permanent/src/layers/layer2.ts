// Layer 2 - Middle layer for deep call chain benchmarks
import { layer3Func } from './layer3';

export function layer2Func(input: string): string {
  return layer3Func('Layer2:' + input);
}

export function layer2Transform(data: string): string {
  return layer3Func(data.toUpperCase());
}

export class Layer2Processor {
  process(msg: string): string {
    return layer3Func('processed:' + msg);
  }
}
