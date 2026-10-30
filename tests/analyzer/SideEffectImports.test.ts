import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Parser } from '../../src/analyzer/Parser';
import { Spider } from '../../src/analyzer/Spider';
import { SpiderBuilder } from '../../src/analyzer/SpiderBuilder';
import { normalizePath } from '../../src/shared/path';

describe('Parser - side-effect imports (#515)', () => {
    const parser = new Parser();
    const sideEffects = (content: string, filePath?: string) =>
        parser.parse(content, filePath).filter((p) => p.type === 'side-effect').map((p) => p.module);

    it.each([
        ["single quotes", "import './x';", ['./x']],
        ["double quotes", 'import "./x";', ['./x']],
        ["no semicolon, no space", "import'./x'", ['./x']],
        ["extension", "import './x.js';", ['./x.js']],
        ["scoped package", "import '@scope/pkg/side';", ['@scope/pkg/side']],
        ["non-code file", "import './style.css';", ['./style.css']],
        ["indented", "  \timport './x';", ['./x']],
        ["specifier on the next line", "import\n  './x';", ['./x']],
        ["several, in order", "import './a';\nimport './b';", ['./a', './b']],
        ["duplicate", "import './a';\nimport './a';", ['./a']],
    ])('records %s', (_name, content, expected) => {
        expect(sideEffects(content)).toEqual(expected);
    });

    it.each([
        ["line comment", "// import './x';"],
        ["block comment", "/* import './x' */"],
        ["multi-line block comment", "/*\nimport './x';\n*/"],
        ["string", "const s = \"import './x'\";"],
        ["template literal", "const s = `import './x'`;"],
        ["multi-line template literal", "const s = `\nimport './x';\n`;"],
        ["string after a semicolon", "const s = \"a; import './x'\";"],
        ["string after a brace", "const s = 'x {import \"./x\"}';"],
        ["member call", "foo.import('./x');"],
        ["dynamic import", "import('./x');"],
        ["named import", "import { a } from './x';"],
        ["identifier ending in import", "reimport './x';"],
    ])('ignores %s', (_name, content) => {
        expect(sideEffects(content)).toEqual([]);
    });

    it('reports the line of the statement', () => {
        expect(parser.parse("const a = 1;\n\nimport './x';").find((p) => p.type === 'side-effect')?.line).toBe(3);
    });

    it('keeps a bare import next to a named import of the same module', () => {
        const parsed = parser.parse("import { a } from './x';\nimport './x';");
        expect(parsed.map((p) => p.type)).toEqual(['import', 'side-effect']);
    });

    it('reads bare imports in a Vue <script> block only', () => {
        const vue = "<template><p>import './nope'</p></template>\n<script setup>\nimport './x';\n</script>";
        expect(sideEffects(vue, 'App.vue')).toEqual(['./x']);
        expect(sideEffects("<script>\nimport './y';\n</script>", 'App.svelte')).toEqual(['./y']);
    });
});

describe('Spider - side-effect imports (#515)', () => {
    const root = path.resolve(process.cwd(), 'tests/analyzer/fixtures/side-effect-imports');
    const file = (name: string) => normalizePath(path.join(root, name));
    let spider: Spider;

    beforeAll(async () => {
        spider = new SpiderBuilder().withRootDir(root).withReverseIndex(true).build();
        await spider.buildFullIndex();
    });

    afterAll(async () => {
        await spider.dispose();
    });

    it('records each resolved bare import as a dependency, and ignores an unresolved one', async () => {
        const deps = await spider.analyze(file('main.ts'));
        expect(deps.map((d) => [normalizePath(d.path), d.type])).toEqual([
            [file('side.ts'), 'side-effect'],
            [file('side2.ts'), 'side-effect'],
            [file('style.css'), 'side-effect'],
        ]);
    });

    it('lists the importer of a side-effect-imported file', async () => {
        const refs = await spider.findReferencingFiles(file('side.ts'));
        expect(refs.map((r) => normalizePath(r.path)).sort()).toEqual([file('App.vue'), file('main.ts')]);
        expect(refs.every((r) => r.type === 'side-effect')).toBe(true);
    });

    it('records a bare import in a Vue <script> block', async () => {
        const deps = await spider.analyze(file('App.vue'));
        expect(deps.map((d) => normalizePath(d.path))).toEqual([file('side.ts')]);
    });

    it('closes a cycle made of side-effect imports only', async () => {
        const { edges } = await spider.crawl(file('cycle-a.ts'));
        const pairs = edges.map((e) => [normalizePath(e.source), normalizePath(e.target)]);
        expect(pairs).toContainEqual([file('cycle-a.ts'), file('cycle-b.ts')]);
        expect(pairs).toContainEqual([file('cycle-b.ts'), file('cycle-a.ts')]);
    });

    it('never reports a bare import as unused', async () => {
        expect(await spider.verifyDependencyUsage(file('main.ts'), file('side.ts'))).toBe(true);
        const batch = await spider.verifyDependencyUsageBatch(file('main.ts'), [file('side.ts'), file('side2.ts')]);
        expect([...batch.values()]).toEqual([true, true]);
    });

    it('keeps a bare import used when its named import beside it is unused', async () => {
        expect(await spider.verifyDependencyUsage(file('named-and-bare.ts'), file('target.ts'))).toBe(true);
    });

    it('still reports an unrelated target of the same file as unused', async () => {
        expect(await spider.verifyDependencyUsage(file('main.ts'), file('target.ts'))).toBe(false);
    });
});
