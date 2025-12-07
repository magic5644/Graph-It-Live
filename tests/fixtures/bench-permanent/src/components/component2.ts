import { shared, helper } from '../shared';
import { util6, util7, util8 } from '../utils';

export const component2Data = shared + helper;
export function component2Init() { return util6(); }
export function component2Render() { return util7() + util8(); }
export class Component2 {
  name = 'Component2';
  render() { return component2Render(); }
}
