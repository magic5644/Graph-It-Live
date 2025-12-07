import { shared, helper } from '../shared';
import { util12, util13, util14 } from '../utils';

export const component4Data = shared + helper;
export function component4Init() { return util12(); }
export function component4Render() { return util13().concat(util14()); }
export class Component4 {
  name = 'Component4';
  render() { return component4Render(); }
}
