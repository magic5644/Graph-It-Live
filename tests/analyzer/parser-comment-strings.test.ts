import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Parser } from '@/analyzer/Parser';

/** Imported modules of `content`, in order. */
function modules(content: string): string[] {
    return new Parser().parse(content).map((i) => i.module);
}

describe('Parser - comments next to quotes (#523 review gate)', () => {
    it.each<[string, string, string[]]>([
        [
            'regex literal with quotes before a commented import',
            "const s = /'[^']*'|\"[^\"]*\"/;\n// import ... from '...'\nimport a from './a';",
            ['./a'],
        ],
        [
            'escaped quote inside a string',
            "const s = 'it\\'s'; // import x from './fake'\nimport a from './a';",
            ['./a'],
        ],
        [
            'escaped double quote inside a string',
            'const s = "say \\"hi\\""; // import x from \'./fake\'\nimport a from \'./a\';',
            ['./a'],
        ],
        ['URL in a string is not a comment', "const u = 'http://x';\nimport a from './a';", ['./a']],
        ['block comment opener in a string', "const s = '/*';\nimport a from './a';\nconst t = '*/';", ['./a']],
        ['apostrophe in a line comment', "// don't import b from './b'\nimport a from './a';", ['./a']],
        ['apostrophe in a block comment', "/* it's\n import b from './b' */\nimport a from './a';", ['./a']],
        ['unterminated quote stays on its line', "const s = 'oops\n// import x from './fake'\nimport a from './a';", ['./a']],
        ['Windows line endings', "const s = /'/;\r\n// import x from './fake'\r\nimport a from './a';\r\n", ['./a']],
    ])('%s', (_title, content, expected) => {
        expect(modules(content)).toEqual(expected);
    });

    it('keeps line numbers after stripping', () => {
        const [parsed] = new Parser().parse("const s = /'/;\n// import x from './fake'\n\nimport a from './a';");
        expect(parsed.line).toBe(4);
    });

    it("reads only the real imports of Parser.ts, whose regex literals hold quotes", () => {
        const source = fs.readFileSync(path.resolve('src/analyzer/Parser.ts'), 'utf8');
        expect(modules(source)).toEqual(['./FileReader', './types', './utils/PathExtractor', './utils/PathResolver']);
    });
});
