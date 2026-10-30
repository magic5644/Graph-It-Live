import { starUsed, namedUsed, renamed, dflt, nested, nsbarrel, deepLeaf, twin, localReexport, escns, type TOnly } from './lib';
import { xFn } from './cyc/x';
const t: TOnly = { x: 1 };
console.log(starUsed(), namedUsed(), renamed(), dflt(), nested(), nsbarrel.nsx(), t);
console.log(deepLeaf(), twin(), xFn(), localReexport());
console.log(Object.keys(escns));
