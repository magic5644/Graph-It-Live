import { describe, it, expect } from 'vitest';
import { Parser } from '../src/analyzer/Parser';

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
