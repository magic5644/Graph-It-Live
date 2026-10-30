import { starUsed, namedUsed, renamed, dflt, nested, nsbarrel } from './lib';
import type { TOnly } from './lib';
const t: TOnly = { x: 1 };
console.log(starUsed(), namedUsed(), renamed(), dflt(), nested(), nsbarrel.nsx(), t);
import { deepLeaf, twin, localReexport, escns } from './lib';
import { xFn } from './cyc/x';
console.log(deepLeaf(), twin(), xFn(), localReexport());
console.log(Object.keys(escns));
