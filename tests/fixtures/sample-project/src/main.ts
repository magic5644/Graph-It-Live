import { greet } from './utils';
import { Button } from '@components/Button';

function main() {
  console.log(greet('World'));
  const btn = new Button();
  btn.render();
}

export { main };
