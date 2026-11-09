import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import https from 'node:https';

// Single sources: plugins/graph-it-live/plugin.json for the shared plugin
// fields, and the published npm version for every version field and the
// pinned MCP server package. Every other manifest is derived from them.
const packageName = '@magic5644/graph-it-live';
const pluginManifestPath = 'plugins/graph-it-live/plugin.json';
const nativeManifestPaths = [
  'plugins/graph-it-live/.codex-plugin/plugin.json',
  'plugins/graph-it-live/.claude-plugin/plugin.json',
];
const portableMcpPath = 'plugins/graph-it-live/mcp.json';
const nativeMcpPath = 'plugins/graph-it-live/.mcp.json';
const claudeMarketplacePath = '.claude-plugin/marketplace.json';
// Copilot CLI reads either catalog but documents this location; it mirrors the Claude one.
const copilotMarketplacePath = '.github/plugin/marketplace.json';

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

// npx runs an exact pinned version from its cache after revalidating the package
// metadata, and downloads the package only on a cache miss. No --prefer-offline: it
// trusts metadata cached before a release and fails with ETARGET.
function mcpServer(version) {
  return { command: 'npx', args: ['-y', `${packageName}@${version}`, 'serve'] };
}

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const requestedVersion = args.find((arg) => !arg.startsWith('--'));
const version = requestedVersion ?? await fetchLatestVersion();

if (!isSemver(version)) {
  throw new Error(`Invalid plugin version: ${version}`);
}

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const mismatches = [];

async function sync(path, content) {
  const text = `${JSON.stringify(content, null, 2)}\n`;
  const current = await readFile(path, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  // Windows checkouts with core.autocrlf turn LF into CRLF; line endings are not drift.
  if (current?.replaceAll('\r\n', '\n') === text) return;
  mismatches.push(path);
  if (checkOnly) return;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

const pluginManifest = { ...await readJson(pluginManifestPath), version };
await sync(pluginManifestPath, pluginManifest);

// Native manifests keep their own keys; the keys they share with plugin.json
// are copied from it.
for (const path of nativeManifestPaths) {
  const manifest = await readJson(path);
  for (const key of Object.keys(manifest)) {
    if (key !== '$schema' && key in pluginManifest) manifest[key] = pluginManifest[key];
  }
  await sync(path, manifest);
}

const portableMcp = await readJson(portableMcpPath);
portableMcp.mcpServers = { 'graph-it-live': { type: 'stdio', ...mcpServer(version) } };
await sync(portableMcpPath, portableMcp);
await sync(nativeMcpPath, { mcpServers: { 'graph-it-live': mcpServer(version) } });

const claudeMarketplace = await readJson(claudeMarketplacePath);
const marketplaceEntry = claudeMarketplace.plugins.find(({ name }) => name === 'graph-it-live');
if (!marketplaceEntry) throw new Error(`Missing graph-it-live entry in ${claudeMarketplacePath}`);
marketplaceEntry.version = version;
marketplaceEntry.description = pluginManifest.description;
marketplaceEntry.source = `./${dirname(pluginManifestPath)}`;
await sync(claudeMarketplacePath, claudeMarketplace);
await sync(copilotMarketplacePath, claudeMarketplace);

if (checkOnly && mismatches.length > 0) {
  console.error(`Plugin manifests do not match ${packageName}@${version}; run node scripts/sync-agent-plugin-version.mjs ${version}:`);
  console.error(mismatches.join('\n'));
  process.exitCode = 1;
} else if (mismatches.length > 0) {
  console.log(`Updated plugin manifests to ${version}:\n${mismatches.join('\n')}`);
} else {
  console.log(`Plugin manifests already match ${version}`);
}
