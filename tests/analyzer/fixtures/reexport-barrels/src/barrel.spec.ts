import { it } from 'vitest';
import { onlyTestUsed } from './lib';

it('uses a symbol only a test file imports', () => {
  onlyTestUsed();
});
