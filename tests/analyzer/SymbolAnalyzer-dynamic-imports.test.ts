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

    it('reads a rest element or a module object used as a whole as every export (*)', () => {
        const content = `
export async function main() {
    const { run, ...rest } = await import("./a");
    const mod = await import("./b");
    return [run, rest, mod];
}
`;
        const result = analyzer.analyzeFileContent('/test/index.ts', content);

        const targets = result.dependencies.map(d => d.targetSymbolId).sort();
        expect(targets).toEqual(['./a:*', './a:run', './b:*']);
    });

    it('reads a whole-module import type as every export, and a qualified one as its name', () => {
        const content = `
export type Whole = typeof import("./m");
export type One = import("./n").Item.Sub;
`;
        const result = analyzer.analyzeFileContent('/test/index.ts', content);

        expect(result.dependencies.map(d => [d.targetSymbolId, d.isTypeOnly]).sort()).toEqual([['./m:*', true], ['./n:Item', true]]);
    });

    it('reads only the members accessed on a module object, and default when it is unused', () => {
        const content = `
export async function main() {
    const mod = await import("./b");
    const other = { mod: 1 };
    await import("./c").then((unused) => 0);
    return mod.run() + mod.stop + other.mod;
}
export async function idle() {
    const lone = await import("./d");
}
`;
        const result = analyzer.analyzeFileContent('/test/index.ts', content);

        expect(result.dependencies.map(d => d.targetSymbolId).sort()).toEqual(['./b:run', './b:stop', './c:default', './d:default']);
    });

    describe('require() with a literal path (#696)', () => {
        const targets = (content: string): string[] =>
            analyzer.analyzeFileContent('/test/user.ts', content).dependencies
                .filter((d) => d.targetFilePath === './m')
                .map((d) => d.targetSymbolId.slice('./m:'.length))
                .sort((a, b) => a.localeCompare(b));

        it('reads destructured names, renamed and rest', () => {
            expect(targets("export function f() { const { a, b: c } = require('./m'); return a + c; }")).toEqual(['a', 'b']);
            expect(targets("export function f() { const { a, ...rest } = require('./m'); return rest; }")).toEqual(['*', 'a']);
        });

        it('reads a member read on the call or on its binding', () => {
            expect(targets("export const v = require('./m').run();")).toEqual(['run']);
            expect(targets("export function f() { const m = require('./m'); return m.go(); }")).toEqual(['go']);
            expect(targets('export function f() { return require(`./m`).tpl; }')).toEqual(['tpl']);
        });

        it('counts every export when the module object escapes', () => {
            expect(targets("export const load = () => require('./m');")).toEqual(['*']);
            expect(targets("export function f() { register(require('./m')); }")).toEqual(['*']);
            expect(targets("export function f() { const m = require('./m'); return use(m); }")).toEqual(['*']);
        });

        it('ignores a side-effect require, a computed path and another function named like require', () => {
            expect(targets("export function f() { require('./m'); }")).toEqual(['default']);
            expect(targets("export function f(name: string) { return require(name); }")).toEqual([]);
            expect(targets("export function f() { return my.require('./m'); }")).toEqual([]);
        });
    });
});
