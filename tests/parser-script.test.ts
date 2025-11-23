import { describe, it, expect } from 'vitest';
import { Parser } from '../src/analyzer/Parser';

describe('Parser - Script Extraction', () => {
    const parser = new Parser();

    it('should extract script content with standard closing tag', () => {
        const content = `<script>
import { foo } from './foo';
</script>`;
        const imports = parser.parse(content, 'test.vue');
        expect(imports).toHaveLength(1);
        expect(imports[0].module).toBe('./foo');
    });

    it('should extract script content with space in closing tag', () => {
        const content = `<script>
import { bar } from './bar';
</script >`;
        const imports = parser.parse(content, 'test.vue');
        expect(imports).toHaveLength(1);
        expect(imports[0].module).toBe('./bar');
    });
});
