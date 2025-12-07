import { shared, helper } from '../shared';
import { util3, util4, util5 } from '../utils';

export const component1Data = shared + helper;
export function component1Init() { return util3(); }
export function component1Render() { return util4() + util5(); }
export class Component1 {
  name = 'Component1';
  render() { return component1Render(); }
}
