// Large class with 30+ methods for symbol analysis benchmarks
import { shared, helper, formatDate, parseNumber } from './shared';
import { util0, util1, util2, util3, util4 } from './utils';

export class LargeClass {
  private data: string = shared;
  
  method0() { return this.data + helper; }
  method1() { return this.data + helper; }
  method2() { return formatDate(new Date()); }
  method3() { return parseNumber('42'); }
  method4() { return util0(); }
  method5() { return util1(); }
  method6() { return util2(); }
  method7() { return util3(); }
  method8() { return util4(); }
  method9() { return this.method1() + this.method2(); }
  method10() { return this.method3() + this.method4(); }
  method11() { return this.method5() + this.method6(); }
  method12() { return this.method7() + this.method8(); }
  method13() { return Math.random(); }
  method14() { return Date.now(); }
  method15() { return JSON.stringify({ a: 1 }); }
  method16() { return JSON.parse('{"b":2}'); }
  method17() { return [1, 2, 3].map(x => x * 2); }
  method18() { return [1, 2, 3].filter(x => x > 1); }
  method19() { return [1, 2, 3].reduce((a, b) => a + b, 0); }
  method20() { return new Set([1, 2, 3]); }
  method21() { return new Map([['a', 1]]); }
  method22() { return Promise.resolve(42); }
  method23() { return String(123); }
  method24() { return Number('456'); }
  method25() { return Boolean(1); }
  method26() { return 'hello'.toUpperCase(); }
  method27() { return 'WORLD'.toLowerCase(); }
  method28() { return '  trim  '.trim(); }
  method29() { return 'split'.split(''); }
  method30() { return ['j', 'o', 'i', 'n'].join(''); }
}

export function createLargeClass(): LargeClass {
  return new LargeClass();
}

export const LARGE_CLASS_VERSION = '1.0.0';
