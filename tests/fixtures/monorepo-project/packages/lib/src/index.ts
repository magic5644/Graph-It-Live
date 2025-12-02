// Lib main entry point
import { secret } from '#internal/secret';
import { config } from '#config';

export function getConfig() {
  return { secret, config };
}
