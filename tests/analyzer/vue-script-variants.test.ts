import { describe, it, expect } from 'vitest';
import { Parser } from '../../src/analyzer/Parser';

describe('Parser - Vue Script Variants', () => {
    const parser = new Parser();

    it('should extract script content from <script setup>', () => {
        const content = `<script setup>
import { foo } from './foo';
</script>`;
        const imports = parser.parse(content, 'test.vue');
        expect(imports).toHaveLength(1);
        expect(imports[0].module).toBe('./foo');
    });

    it('should extract script content from <script lang="ts">', () => {
        const content = `<script lang="ts">
import { bar } from './bar';
</script>`;
        const imports = parser.parse(content, 'test.vue');
        expect(imports).toHaveLength(1);
        expect(imports[0].module).toBe('./bar');
    });

    it('should extract script content from <script setup lang="ts">', () => {
        const content = `<script setup lang="ts">
import { baz } from './baz';
</script>`;
        const imports = parser.parse(content, 'test.vue');
        expect(imports).toHaveLength(1);
        expect(imports[0].module).toBe('./baz');
    });

    it('should handle empty script tags', () => {
        const content = `<script></script>`;
        const imports = parser.parse(content, 'test.vue');
        expect(imports).toHaveLength(0);
    });

    it('should handle script tags with attributes and spaces', () => {
        const content = `<script  setup  lang="ts" >
import { qux } from './qux';
</script >`;
        const imports = parser.parse(content, 'test.vue');
        expect(imports).toHaveLength(1);
        expect(imports[0].module).toBe('./qux');
    });

    it('should handle multiple script tags (script and script setup)', () => {
        const content = `<script>
import { normal } from './normal';
</script>
<script setup>
import { setup } from './setup';
</script>`;
        // Note: Current parser might only pick the first one or last one depending on regex.
        // Ideally it should pick both or concatenate them.
        const imports = parser.parse(content, 'test.vue');
        // Let's see what it does currently. If it fails, we know we need to fix it.
        // Expecting at least one for now, but ideally 2.
        expect(imports.length).toBeGreaterThan(0);
        const modules = imports.map(i => i.module);
        expect(modules).toContain('./normal');
        expect(modules).toContain('./setup');
    });
});
