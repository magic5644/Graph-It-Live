import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Checks the files `vsce ls` would package: no source maps, and the extension icon.
// A Node script, not a shell one-liner: npm runs scripts with cmd.exe on Windows.
// Usage: node scripts/verify-package.mjs

const ICON = 'media/Graph-It-Live-Logo-256.png';

/** Returns one error message per failed check of the packaged file list. */
export function packageErrors(listing) {
  const files = listing.split(/\r?\n/).map((line) => line.trim().replaceAll('\\', '/')).filter(Boolean);
  const errors = [];
  const maps = files.filter((file) => file.endsWith('.map'));
  if (maps.length > 0) errors.push(`.map files found in package: ${maps.join(', ')}`);
  if (!files.includes(ICON)) errors.push(`extension icon missing from package: ${ICON}`);
  return errors;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const errors = packageErrors(execSync('npx vsce ls', { encoding: 'utf8' }));
  for (const error of errors) console.error(`❌ ERROR: ${error}`);
  if (errors.length > 0) process.exit(1);
  console.log('✅ No .map files in package');
  console.log('✅ Extension icon in package');
}
