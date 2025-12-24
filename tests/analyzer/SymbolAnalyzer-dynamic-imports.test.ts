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
        const result = analyzer.analyzeFile('/test/router.ts', content);
        
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
        const result = analyzer.analyzeFile('/test/router.ts', content);
        
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
        const result = analyzer.analyzeFile('/test/config.ts', content);
        
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
        const result = analyzer.analyzeFile('/test/router-mixed.ts', content);
        
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
        const result = analyzer.analyzeFile('/test/loader.ts', content);
        
        const homeDeps = result.dependencies.filter(
            d => d.targetFilePath === './views/Home.vue'
        );
        const fallbackDeps = result.dependencies.filter(
            d => d.targetFilePath === './views/Fallback.vue'
        );
        
        expect(homeDeps.length).toBeGreaterThan(0);
        expect(fallbackDeps.length).toBeGreaterThan(0);
    });
});
