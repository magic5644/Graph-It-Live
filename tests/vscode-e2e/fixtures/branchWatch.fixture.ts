import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

export const branchWatchLanguages = [
  { name: 'TypeScript', source: 'typescript/api.ts', consumer: 'typescript/consumer.ts', content: 'export function value(n: number) { return n; }\n', changed: 'export function value(n: number, required: boolean) { return n + 1; }\n', use: "import { value } from './api'; export const result = value(1);\n" },
  { name: 'JavaScript', source: 'javascript/api.js', consumer: 'javascript/consumer.js', content: 'export function value(n) { return n; }\n', changed: 'export function value(n, required) { return n + 1; }\n', use: "import { value } from './api.js'; export const result = value(1);\n" },
  { name: 'Python', source: 'python/api.py', consumer: 'python/consumer.py', content: 'def value(n):\n    return n\n', changed: 'def value(n):\n    return n + 1\n', use: 'from .api import value\nresult = value(1)\n' },
  { name: 'Rust', source: 'rust/api.rs', consumer: 'rust/consumer.rs', content: 'pub fn value(n: i32) -> i32 { n }\n', changed: 'pub fn value(n: i32) -> i32 { n + 1 }\n', use: 'mod api;\npub fn result() -> i32 { api::value(1) }\n' },
  { name: 'C#', source: 'Services/Api.cs', consumer: 'Consumers/Consumer.cs', content: 'namespace Demo.Services { public class Api { public int Value(int n) { return n; } } }\n', changed: 'namespace Demo.Services { public class Api { public int Value(int n) { return n + 1; } } }\n', use: 'using Demo.Services;\nnamespace Demo.Consumers { public class Consumer { public int Use() { return new Api().Value(1); } } }\n' },
  { name: 'Go', source: 'api/api.go', consumer: 'consumer/consumer.go', content: 'package api\nfunc Value(n int) int { return n }\n', changed: 'package api\nfunc Value(n int) int { return n + 1 }\n', use: 'package consumer\nimport "example.com/watch/api"\nfunc Use() int { return api.Value(1) }\n' },
  { name: 'Java', source: 'src/main/java/demo/Api.java', consumer: 'src/main/java/client/Consumer.java', content: 'package demo;\npublic class Api { public static int value(int n) { return n; } }\n', changed: 'package demo;\npublic class Api { public static int value(int n) { return n + 1; } }\n', use: 'package client;\nimport demo.Api;\npublic class Consumer { public int use() { return Api.value(1); } }\n' },
  { name: 'Vue', source: 'vue/Api.vue', consumer: 'vue/Consumer.vue', content: '<script>export default { data() { return { value: 1 }; } };</script><template><div>value</div></template>\n', changed: '<script>export default { data() { return { value: 2 }; } };</script><template><div>value</div></template>\n', use: '<script>import Api from "./Api.vue"; export default { components: { Api } };</script><template><Api /></template>\n' },
  { name: 'Svelte', source: 'svelte/Api.svelte', consumer: 'svelte/Consumer.svelte', content: '<script>export let value = 1;</script><p>{value}</p>\n', changed: '<script>export let value = 2;</script><p>{value}</p>\n', use: '<script>import Api from "./Api.svelte";</script><Api />\n' },
  { name: 'GraphQL', source: 'graphql/api.graphql', consumer: 'graphql/consumer.graphql', content: 'fragment Fields on User { id }\n', changed: 'fragment Fields on User { id name }\n', use: '# import "./api.graphql"\nquery UserQuery { user { ...Fields } }\n' },
] as const;

export function fixtureGit(root: string, ...args: string[]): string {
  const gitCommand = process.platform === 'win32' ? 'git.exe' : '/usr/bin/git';
  return execFileSync(gitCommand, ['-c', `core.hooksPath=${path.join(root, '.empty-git-hooks')}`, ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export async function createBranchWatchFixture(mode: 'git' | 'noGit' | 'unborn' = 'git'): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'graph-it-branch-e2e-')));
  for (const language of branchWatchLanguages) {
    for (const [file, content] of [[language.source, language.content], [language.consumer, language.use]]) {
      await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await fs.writeFile(path.join(root, file), content);
    }
    await fs.writeFile(path.join(root, path.dirname(language.source), `isolated${path.extname(language.source)}`), language.content);
  }
  await fs.writeFile(path.join(root, 'go.mod'), 'module example.com/watch\n\ngo 1.22\n');
  await fs.writeFile(path.join(root, 'python/__init__.py'), '');
  await fs.writeFile(path.join(root, 'tsconfig.json'), '{"compilerOptions":{"jsx":"preserve"}}');
  await fs.writeFile(path.join(root, '.gitignore'), '.vscode/\n.graph-it-live/\n');
  await fs.mkdir(path.join(root, '.empty-git-hooks'));
  if (mode !== 'noGit') {
    fixtureGit(root, 'init', '-b', 'main');
    fixtureGit(root, 'config', 'user.email', 'fixture@example.com');
    fixtureGit(root, 'config', 'user.name', 'Fixture');
    if (mode === 'git') { fixtureGit(root, 'add', '.'); fixtureGit(root, 'commit', '-m', 'base'); fixtureGit(root, 'switch', '-c', 'feature'); }
  }
  return root;
}
