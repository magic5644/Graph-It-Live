import { readFile, writeFile } from 'node:fs/promises';
import https from 'node:https';

const packageName = '@magic5644/graph-it-live';
const manifestPaths = [
  'plugins/graph-it-live/plugin.json',
  'plugins/graph-it-live/.codex-plugin/plugin.json',
  'plugins/graph-it-live/.claude-plugin/plugin.json',
];
const claudeMarketplacePath = '.claude-plugin/marketplace.json';

function isSemver(version) {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version);
}

function fetchLatestVersion() {
  return new Promise((resolve, reject) => {
    const request = https.get(`https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`npm registry returned HTTP ${response.statusCode}`));
        return;
      }
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        try {
          resolve(JSON.parse(body).version);
        } catch {
          reject(new Error('npm registry returned invalid JSON'));
        }
      });
    }).on('error', reject);
    request.setTimeout(10_000, () => request.destroy(new Error('npm registry request timed out')));
  });
}

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const requestedVersion = args.find((arg) => !arg.startsWith('--'));
const version = requestedVersion ?? await fetchLatestVersion();

if (!isSemver(version)) {
  throw new Error(`Invalid plugin version: ${version}`);
}

const mismatches = [];
for (const path of manifestPaths) {
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  if (manifest.version !== version) mismatches.push(`${path}: ${manifest.version} -> ${version}`);
  if (!checkOnly && manifest.version !== version) {
    manifest.version = version;
    await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
  }
}

const claudeMarketplace = JSON.parse(await readFile(claudeMarketplacePath, 'utf8'));
const marketplaceEntry = claudeMarketplace.plugins.find(({ name }) => name === 'graph-it-live');
if (!marketplaceEntry) throw new Error(`Missing graph-it-live entry in ${claudeMarketplacePath}`);
if (marketplaceEntry.version !== version) {
  mismatches.push(`${claudeMarketplacePath}: ${marketplaceEntry.version} -> ${version}`);
  if (!checkOnly) {
    marketplaceEntry.version = version;
    await writeFile(claudeMarketplacePath, `${JSON.stringify(claudeMarketplace, null, 2)}\n`);
  }
}

if (checkOnly && mismatches.length > 0) {
  console.error(`Plugin manifests do not match ${packageName}@${version}:`);
  console.error(mismatches.join('\n'));
  process.exitCode = 1;
} else if (mismatches.length > 0) {
  console.log(`Updated plugin manifests to ${version}`);
} else {
  console.log(`Plugin manifests already match ${version}`);
}
