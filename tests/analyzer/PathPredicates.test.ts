import { describe, it, expect } from 'vitest';
import { isInIgnoredDirectory } from '../../src/analyzer/utils/PathPredicates';

describe('PathPredicates', () => {
    describe('isInIgnoredDirectory', () => {
        it('should detect files in node_modules', () => {
            expect(isInIgnoredDirectory('/project/node_modules/package/index.js')).toBe(true);
            expect(isInIgnoredDirectory('/project/src/node_modules/package/index.js')).toBe(true);
        });

        it('should detect files in dist directory', () => {
            expect(isInIgnoredDirectory('/project/dist/bundle.js')).toBe(true);
            expect(isInIgnoredDirectory('/project/src/dist/bundle.js')).toBe(true);
        });

        it('should detect files in build directory', () => {
            expect(isInIgnoredDirectory('/project/build/output.js')).toBe(true);
        });

        it('should detect files in out directory', () => {
            expect(isInIgnoredDirectory('/project/out/compiled.js')).toBe(true);
        });

        it('should detect files in coverage directory', () => {
            expect(isInIgnoredDirectory('/project/coverage/report.html')).toBe(true);
        });

        it('should detect files in .git directory', () => {
            expect(isInIgnoredDirectory('/project/.git/config')).toBe(true);
        });

        it('should detect files in target directory (Rust)', () => {
            expect(isInIgnoredDirectory('/project/target/debug/app')).toBe(true);
        });

        it('should detect files in __pycache__ directory (Python)', () => {
            expect(isInIgnoredDirectory('/project/__pycache__/module.pyc')).toBe(true);
        });

        it('should detect files in venv directory (Python)', () => {
            expect(isInIgnoredDirectory('/project/venv/lib/python3.9/site-packages/package.py')).toBe(true);
            expect(isInIgnoredDirectory('/project/.venv/lib/python3.9/site-packages/package.py')).toBe(true);
        });

        it('should NOT detect files whose NAME contains ignored directory names', () => {
            // These are FILES that contain "target" in their name, not directories
            expect(isInIgnoredDirectory('/project/src/target.ts')).toBe(false);
            expect(isInIgnoredDirectory('/project/components/targeting.js')).toBe(false);
            expect(isInIgnoredDirectory('/project/src/build_utils.ts')).toBe(false);
            expect(isInIgnoredDirectory('/project/src/dist_config.ts')).toBe(false);
        });

        it('should NOT detect normal source files', () => {
            expect(isInIgnoredDirectory('/project/src/index.ts')).toBe(false);
            expect(isInIgnoredDirectory('/project/components/Button.tsx')).toBe(false);
            expect(isInIgnoredDirectory('/project/utils/helpers.js')).toBe(false);
        });

        it('should handle Windows-style paths (after normalization)', () => {
            // These would be normalized to forward slashes before checking
            expect(isInIgnoredDirectory('c:/project/node_modules/package/index.js')).toBe(true);
            expect(isInIgnoredDirectory('c:/project/src/target.ts')).toBe(false);
        });

        it('should handle paths with multiple segments', () => {
            expect(isInIgnoredDirectory('/home/user/projects/myapp/node_modules/lodash/index.js')).toBe(true);
            expect(isInIgnoredDirectory('/home/user/projects/myapp/src/services/target_api.ts')).toBe(false);
        });
    });
});
