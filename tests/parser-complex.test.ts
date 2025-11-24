import { describe, it, expect } from 'vitest';
import { Parser } from '../src/analyzer/Parser';

describe('Parser - Complex Imports', () => {
    const parser = new Parser();

    it('should handle multiline imports', () => {
        const content = `
import {
  foo,
  bar
} from './module';
`;
        const imports = parser.parse(content);
        expect(imports).toHaveLength(1);
        expect(imports[0].module).toBe('./module');
    });

    it('should handle imports with comments containing semicolons', () => {
        const content = `
import {
  // comment with ; semicolon
  foo
} from './semicolon-comment';
`;
        const imports = parser.parse(content);
        expect(imports).toHaveLength(1);
        expect(imports[0].module).toBe('./semicolon-comment');
    });

    it('should handle exports with comments containing semicolons', () => {
        const content = `
export {
  // comment with ; semicolon
  bar
} from './export-semicolon';
`;
        const imports = parser.parse(content);
        expect(imports).toHaveLength(1);
        expect(imports[0].module).toBe('./export-semicolon');
    });
});
