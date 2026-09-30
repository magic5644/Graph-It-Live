import { describe, it, expect } from 'vitest';
import { SymbolAnalyzer } from '../../src/analyzer/SymbolAnalyzer';

describe('SymbolAnalyzer - Dynamic Imports', () => {
    const analyzer = new SymbolAnalyzer();

    it('should detect dynamic import in arrow function', () => {
        const content = `
export const routes = [
    {
        path: "home",
        component: () => import("./views/Home.vue"),
    }
];
`;
        const result = analyzer.analyzeFileContent('/test/router.ts', content);
        
        // Should have the routes export
        expect(result.symbols).toHaveLength(1);
        expect(result.symbols[0].name).toBe('routes');
        
        // Should have a dependency to Home.vue
        const deps = result.dependencies.filter(d => d.targetFilePath === './views/Home.vue');
        expect(deps.length).toBeGreaterThan(0);
        expect(deps[0].isTypeOnly).toBe(false);
    });

    it('should detect multiple dynamic imports in router config', () => {
        const content = `
export const routes = [
    {
        path: "infos-about",
        name: "info-about-table",
        component: () => import("./views/about/info.vue"),
    },
    {
        path: "home",
        component: () => import("./views/Home.vue"),
    }
];
`;
        const result = analyzer.analyzeFileContent('/test/router.ts', content);
        
        // Should detect both dynamic imports
        const infoAboutDeps = result.dependencies.filter(
            d => d.targetFilePath === './views/about/info.vue'
        );
        const homeDeps = result.dependencies.filter(
            d => d.targetFilePath === './views/Home.vue'
        );
        
        expect(infoAboutDeps.length).toBeGreaterThan(0);
        expect(homeDeps.length).toBeGreaterThan(0);
    });

    it('should handle dynamic imports in nested structures', () => {
        const content = `
export const config = {
    routes: [
        {
            children: [
                {
                    component: () => import("./views/Nested.vue")
                }
            ]
        }
    ]
};
`;
        const result = analyzer.analyzeFileContent('/test/config.ts', content);
        
        const nestedDeps = result.dependencies.filter(
            d => d.targetFilePath === './views/Nested.vue'
        );
        
        expect(nestedDeps.length).toBeGreaterThan(0);
    });

    it('should handle both static and dynamic imports', () => {
        const content = `
import { Router } from 'vue-router';

export const router = new Router({
    routes: [
        {
            component: () => import("./views/Home.vue")
        }
    ]
});
`;
        const result = analyzer.analyzeFileContent('/test/router-mixed.ts', content);
        
        // Should have dependency on vue-router (static import)
        const routerDeps = result.dependencies.filter(
            d => d.targetFilePath === 'vue-router'
        );
        expect(routerDeps.length).toBeGreaterThan(0);
        
        // Should have dependency on Home.vue (dynamic import)
        const homeDeps = result.dependencies.filter(
            d => d.targetFilePath === './views/Home.vue'
        );
        expect(homeDeps.length).toBeGreaterThan(0);
    });

    it('should handle dynamic imports in functions', () => {
        const content = `
export async function loadComponent(name: string) {
    if (name === 'home') {
        return import("./views/Home.vue");
    }
    return import("./views/Fallback.vue");
}
`;
        const result = analyzer.analyzeFileContent('/test/loader.ts', content);
        
        const homeDeps = result.dependencies.filter(
            d => d.targetFilePath === './views/Home.vue'
        );
        const fallbackDeps = result.dependencies.filter(
            d => d.targetFilePath === './views/Fallback.vue'
        );
        
        expect(homeDeps.length).toBeGreaterThan(0);
        expect(fallbackDeps.length).toBeGreaterThan(0);
    });

    it('should record names destructured from await import()', () => {
        const content = `
export async function main() {
    const { run, getHelp: help } = await import("./commands.js");
    return help() + run();
}
`;
        const result = analyzer.analyzeFileContent('/test/index.ts', content);

        const targets = result.dependencies.map(d => d.targetSymbolId).sort();
        expect(targets).toEqual(['./commands.js:getHelp', './commands.js:run']);
    });

    it('should record names destructured in import().then() callbacks', () => {
        const content = `
export function lazy() {
    return import("./lazy").then(({ load }) => load());
}
export function lazyFn() {
    return import("./other").then(function ({ other }) { return other(); });
}
`;
        const result = analyzer.analyzeFileContent('/test/index.ts', content);

        const targets = result.dependencies.map(d => d.targetSymbolId).sort();
        expect(targets).toEqual(['./lazy:load', './other:other']);
    });

    it('should ignore rest elements and fall back to default without destructuring', () => {
        const content = `
export async function main() {
    const { run, ...rest } = await import("./a");
    const mod = await import("./b");
    return [run, rest, mod];
}
`;
        const result = analyzer.analyzeFileContent('/test/index.ts', content);

        const targets = result.dependencies.map(d => d.targetSymbolId).sort();
        expect(targets).toEqual(['./a:run', './b:default']);
    });
});
