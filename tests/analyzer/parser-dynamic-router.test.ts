import { describe, it, expect } from 'vitest';
import { Parser } from '../../src/analyzer/Parser';

describe('Parser - Dynamic Imports in Router Config', () => {
    const parser = new Parser();

    it('should detect dynamic import in arrow function within object literal', () => {
        const content = `
export const routes = [
    {
        path: "info-about",
        name: "info-about-table",
        component: () => import("./views/about/info.vue"),
    }
];
`;
        const imports = parser.parse(content, 'router.ts');
        
        expect(imports).toHaveLength(1);
        expect(imports[0].module).toBe('./views/about/info.vue');
        expect(imports[0].type).toBe('dynamic');
    });

    it('should detect multiple dynamic imports in router config', () => {
        const content = `
export const routes = [
    {
        path: "home",
        component: () => import("./views/Home.vue"),
    },
    {
        path: "about",
        component: () => import("./views/About.vue"),
    }
];
`;
        const imports = parser.parse(content, 'router.ts');
        
        expect(imports).toHaveLength(2);
        expect(imports[0].module).toBe('./views/Home.vue');
        expect(imports[0].type).toBe('dynamic');
        expect(imports[1].module).toBe('./views/About.vue');
        expect(imports[1].type).toBe('dynamic');
    });

    it('should handle dynamic imports with template literals', () => {
        const content = `
const component = () => import(\`./views/\${name}.vue\`);
`;
        const imports = parser.parse(content, 'router.ts');
        
        // Template literals should not be parsed as the path is dynamic
        expect(imports).toHaveLength(0);
    });

    it('should handle dynamic imports in nested arrow functions', () => {
        const content = `
const routes = [
    {
        children: [
            {
                path: "nested",
                component: () => import("./views/Nested.vue"),
            }
        ]
    }
];
`;
        const imports = parser.parse(content, 'router.ts');
        
        expect(imports).toHaveLength(1);
        expect(imports[0].module).toBe('./views/Nested.vue');
        expect(imports[0].type).toBe('dynamic');
    });
});
