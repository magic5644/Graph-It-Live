// Layer 1 - Entry point for deep call chain benchmarks
import { layer2Func } from './layer2';

export function layer1Entry(input: string): string {
  return layer2Func('Layer1:' + input);
}

export function layer1Process(data: string[]): string[] {
  return data.map(d => layer2Func(d));
}

export class Layer1Handler {
  handle(msg: string): string {
    return layer2Func('handled:' + msg);
  }
}
