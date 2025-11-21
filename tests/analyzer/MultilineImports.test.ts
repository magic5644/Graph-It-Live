import { describe, it, expect } from 'vitest';
import { Parser } from '../../src/analyzer/Parser';

describe('Parser - Multiline Imports', () => {
    const parser = new Parser();

    it('should parse standard single-line import', () => {
        const content = "import { foo } from './bar';";
        const result = parser.parse(content);
        expect(result).toHaveLength(1);
        expect(result[0].module).toBe('./bar');
    });

    it('should parse multiline import with braces', () => {
        const content = `
            import {
                foo,
                bar
            } from './utils';
        `;
        const result = parser.parse(content);
        expect(result).toHaveLength(1);
        expect(result[0].module).toBe('./utils');
    });

    it('should parse multiline import where "from" is on a new line', () => {
        const content = `
            import { foo } 
            from './baz';
        `;
        const result = parser.parse(content);
        expect(result).toHaveLength(1);
        expect(result[0].module).toBe('./baz');
    });

    it('should parse multiline named import with "from" on new line', () => {
        const content = `
            import 
            { 
                foo 
            } 
            from 
            './qux';
        `;
        const result = parser.parse(content);
        expect(result).toHaveLength(1);
        expect(result[0].module).toBe('./qux');
    });
});
