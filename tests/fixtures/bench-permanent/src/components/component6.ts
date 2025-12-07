import { shared, helper } from '../shared';
import { util18, util19, util20 } from '../utils';

export const component6Data = shared + helper;
export function component6Init() { return util18(); }
export function component6Render() { return util19() + (util20() ? 1 : 0); }
export class Component6 {
  name = 'Component6';
  render() { return component6Render(); }
}
