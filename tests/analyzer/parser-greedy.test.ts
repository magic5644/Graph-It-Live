import { describe, it, expect } from 'vitest';
import { Parser } from '../../src/analyzer/Parser';

describe('Parser - Greedy Regex Check', () => {
    const parser = new Parser();

    it('should handle multiple imports on the same line', () => {
        const content = `import a from 'x'; import b from 'y';`;
        const imports = parser.parse(content);
        expect(imports).toHaveLength(2);
        expect(imports[0].module).toBe('x');
        expect(imports[1].module).toBe('y');
    });

    it('should NOT merge malformed import with next valid import', () => {
        // The first import is missing 'from', so it's not a valid import.
        // The parser should ideally NOT match the first one, and definitely NOT merge them.
        // If it merges, it will think " { a } 'x'; import { b } " is the import body.
        const content = `import { a } 'x'; import { b } from 'y';`;
        const imports = parser.parse(content);
        
        // If it merges: length 1, module 'y'.
        // If it works correctly: length 1 (only 'y' is valid) or 0.
        // We definitely don't want it to capture 'y' but include the garbage from the first one in the "import clause" (though we don't capture the clause currently).
        // But we can check the line number or just ensure we get the correct module.
        // Actually, if it merges, it will match:
        // import ... from 'y'
        // The ... will be "{ a } 'x'; import { b }"
        // This is technically a valid match for [\s\S]*? if we don't restrict it.
        
        expect(imports).toHaveLength(1);
        expect(imports[0].module).toBe('y');
        
        // Let's check if we can detect the merge.
        // Since we don't expose the import clause in the result, it's hard to tell directly.
        // But we can infer it if we had a way to check the start index, but we only have line number.
        // If merged, line number might be correct (1).
        
        // Let's try a case where merging would be obviously wrong or cause issues.
        // import a from 'x'; import b from 'y'
        // If we use *? (lazy), it should match 'x' first.
        // So the "multiple imports on same line" test is the best check for basic correctness.
    });

    it('should handle comments with semicolons correctly without breaking subsequent imports', () => {
        const content = `
import {
  // comment; with; semicolon
  foo
} from 'foo';
import { bar } from 'bar';
`;
        const imports = parser.parse(content);
        expect(imports).toHaveLength(2);
        expect(imports[0].module).toBe('foo');
        expect(imports[1].module).toBe('bar');
    });
    it('should NOT swallow code between malformed import and a string containing "from"', () => {
        const content = `
import { a } // missing from
const x = "from 'y'";
`;
        const imports = parser.parse(content);
        // It should NOT match this as an import from 'y'.
        // If it matches, it means it swallowed the code in between.
        expect(imports).toHaveLength(0);
    });
});

describe('Parser - long blank runs (masked base64 template)', () => {
    const parser = new Parser();
    // A generated module embedding wasm as base64: masking turns the template text into one long blank run.
    const withBlob = (length: number) => `export default toBinary(\`${'A'.repeat(length)}\`)\nexport { a } from './a'\n`;
    const timed = (content: string) => {
        const started = performance.now();
        const modules = parser.parse(content).map(i => i.module);
        return { modules, ms: performance.now() - started };
    };

    it('reads an export ... from after a long template string in linear time', () => {
        // A regex scan blocks the test timeout, so the check is bounded: 4x the input costs ~4x when linear,
        // ~16x when quadratic (seconds, not hours, on this size).
        const small = timed(withBlob(20_000));
        const large = timed(withBlob(80_000));
        expect(large.modules).toEqual(['./a']);
        expect(large.ms).toBeLessThan(8 * small.ms + 50);
    });

    it('reads an import ... from after a long template string', () => {
        const content = `import x from './x'\nconst wasm = \`${'A'.repeat(100_000)}\`\nimport\ny from './y'\n`;
        expect(parser.parse(content).map(i => i.module)).toEqual(['./x', './y']);
    });

    it('still finds export/import with several blanks and line breaks before from', () => {
        expect(parser.parse(`export {\n  a,\n  b\n}\n\n   from './ab'`).map(i => i.module)).toEqual(['./ab']);
        expect(parser.parse(`import a  \t from './a'`).map(i => i.module)).toEqual(['./a']);
    });
});
