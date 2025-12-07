// Layer 3 - Deeper layer for deep call chain benchmarks
import { layer4Func } from './layer4';

export function layer3Func(input: string): string {
  return layer4Func('Layer3:' + input);
}

export function layer3Validate(data: string): boolean {
  return layer4Func(data).length > 0;
}

export class Layer3Service {
  execute(msg: string): string {
    return layer4Func('executed:' + msg);
  }
}
