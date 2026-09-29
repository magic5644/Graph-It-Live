import type { Options } from './types';
import { helper } from './helper';
import { external } from 'external-pkg';

export function main(options: Options): Options {
  helper();
  helper();
  external();
  return options;
}
