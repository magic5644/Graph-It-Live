import { shared, helper } from '../shared';
import { util9, util10, util11 } from '../utils';

export const component3Data = shared + helper;
export function component3Init() { return util9(); }
export function component3Render() { return util10().concat(util11()); }
export class Component3 {
  name = 'Component3';
  render() { return component3Render(); }
}
