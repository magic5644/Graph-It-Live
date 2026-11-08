import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
import { PathResolver } from '../../src/analyzer/utils/PathResolver';
import { normalizePath } from '../../src/analyzer/types';
import * as fs from 'node:fs/promises';
import { Parser } from '@/analyzer/Parser';
import { SymbolAnalyzer } from '@/analyzer/SymbolAnalyzer';

// Mock fs
vi.mock('node:fs/promises');

const rootDir = path.resolve(process.cwd(), 'temp-test-root');
const np = (p: string) => normalizePath(p);

describe('PathResolver - Svelte Support', () => {
    let resolver: PathResolver;

    beforeEach(() => {
        vi.clearAllMocks();
        resolver = new PathResolver();
    });

    it('should resolve .svelte extension explicitly', async () => {
        // Mock file existence
        vi.mocked(fs.stat).mockResolvedValue({ isFile: () => true } as any);

        const mainFile = path.join(rootDir, 'src', 'main.ts');
        const expectedPath = path.join(rootDir, 'src', 'components', 'Button.svelte');
        const result = await resolver.resolve(mainFile, './components/Button.svelte');
        
        expect(np(result!)).toBe(np(expectedPath));
    });

    it('should resolve .svelte extension implicitly', async () => {
        // Mock file existence logic
        vi.mocked(fs.stat).mockImplementation(async (filePath) => {
            if (np(filePath.toString()).endsWith('Button.svelte')) {
                return { isFile: () => true } as any; // File exists
            }
            throw new Error('File not found');
        });

        const mainFile = path.join(rootDir, 'src', 'main.ts');
        const expectedPath = path.join(rootDir, 'src', 'components', 'Button.svelte');
        const result = await resolver.resolve(mainFile, './components/Button');
        
        expect(np(result!)).toBe(np(expectedPath));
    });
});

// The SFC helper is shared with Vue (#644): Svelte keeps its block regex, gains the original positions.
describe('Svelte SFC analysis (regression)', () => {
    // Call graph positions: tests/analyzer/sfc/vueSfcPositions.test.ts (this file mocks node:fs/promises).
    const svelte = [
        '<script context="module" lang="ts">',
        '  export const prerender = true;',
        '</script>',
        '',
        '<h1>{title}</h1>',
        '',
        '<script lang="ts">',
        "  import { format } from './format';",
        '  export let title: string;',
        '  function shout(): string {',
        '    return format(title);',
        '  }',
        '</script>',
        '',
        '{#if title}<p>{shout()}</p>{/if}',
    ].join('\n');

    it('reports import lines of the .svelte file, CRLF included', () => {
        expect(new Parser().parse(svelte, '/w/Page.svelte').map((i) => [i.module, i.line])).toEqual([['./format', 8]]);
        expect(new Parser().parse(svelte.replaceAll('\n', '\r\n'), '/w/Page.svelte').map((i) => i.line)).toEqual([8]);
    });

    it('lists script symbols of both blocks at their .svelte lines', () => {
        const { symbols } = new SymbolAnalyzer().analyzeFileContent('/w/Page.svelte', svelte);
        expect(symbols.map((s) => [s.name, s.line, s.isExported])).toEqual([['prerender', 2, true], ['title', 9, true], ['shout', 10, false]]);
    });
});
