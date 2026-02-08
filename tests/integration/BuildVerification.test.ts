/**
 * Build Verification Tests
 * 
 * Validates that the build process correctly handles WASM files:
 * - WASM files are copied to dist/ directory
 * - WASM files are included in .vsix package
 * 
 * Requirements: 7.1, 7.2, 7.3
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

describe('Build Verification', () => {
  const distDir = path.join(process.cwd(), 'dist');
  const requiredWasmFiles = [
    'tree-sitter.wasm',
    'tree-sitter-python.wasm',
    'tree-sitter-rust.wasm',
  ];

  describe('dist/ directory WASM files', () => {
    beforeAll(() => {
      // Ensure dist directory exists
      if (!fs.existsSync(distDir)) {
        throw new Error(
          'dist/ directory not found. Run "npm run build" before running this test.'
        );
      }
    });

    it('should contain tree-sitter.wasm', () => {
      const wasmPath = path.join(distDir, 'tree-sitter.wasm');
      expect(fs.existsSync(wasmPath), `tree-sitter.wasm not found at ${wasmPath}`).toBe(true);
      
      // Verify it's a valid WASM file (starts with WASM magic number)
      const buffer = fs.readFileSync(wasmPath);
      const magicNumber = buffer.slice(0, 4);
      expect(magicNumber.toString('hex')).toBe('0061736d'); // \0asm in hex
    });

    it('should contain tree-sitter-python.wasm', () => {
      const wasmPath = path.join(distDir, 'tree-sitter-python.wasm');
      expect(fs.existsSync(wasmPath), `tree-sitter-python.wasm not found at ${wasmPath}`).toBe(true);
      
      // Verify it's a valid WASM file
      const buffer = fs.readFileSync(wasmPath);
      const magicNumber = buffer.slice(0, 4);
      expect(magicNumber.toString('hex')).toBe('0061736d');
    });

    it('should contain tree-sitter-rust.wasm', () => {
      const wasmPath = path.join(distDir, 'tree-sitter-rust.wasm');
      expect(fs.existsSync(wasmPath), `tree-sitter-rust.wasm not found at ${wasmPath}`).toBe(true);
      
      // Verify it's a valid WASM file
      const buffer = fs.readFileSync(wasmPath);
      const magicNumber = buffer.slice(0, 4);
      expect(magicNumber.toString('hex')).toBe('0061736d');
    });

    it('should contain all required WASM files', () => {
      const missingFiles: string[] = [];
      
      for (const wasmFile of requiredWasmFiles) {
        const wasmPath = path.join(distDir, wasmFile);
        if (!fs.existsSync(wasmPath)) {
          missingFiles.push(wasmFile);
        }
      }
      
      expect(missingFiles, `Missing WASM files: ${missingFiles.join(', ')}`).toHaveLength(0);
    });

    it('should have WASM files with reasonable sizes', () => {
      // WASM files should be at least 10KB (sanity check for corruption)
      const minSize = 10 * 1024; // 10KB
      
      for (const wasmFile of requiredWasmFiles) {
        const wasmPath = path.join(distDir, wasmFile);
        const stats = fs.statSync(wasmPath);
        expect(
          stats.size,
          `${wasmFile} is too small (${stats.size} bytes), may be corrupted`
        ).toBeGreaterThan(minSize);
      }
    });
  });

  describe('.vsix package WASM files', () => {
    let vsixPath: string | null = null;
    let vsixContents: string[] = [];

    beforeAll(() => {
      // Find the most recent .vsix file in the workspace root
      const workspaceRoot = process.cwd();
      const files = fs.readdirSync(workspaceRoot);
      const vsixFiles = files.filter(f => f.endsWith('.vsix'));
      
      if (vsixFiles.length === 0) {
        // Skip these tests if no .vsix file exists
        console.warn(
          'No .vsix file found. Run "npm run package" to create one before running these tests.'
        );
        return;
      }
      
      // Get the most recent .vsix file
      vsixPath = vsixFiles
        .map(f => ({
          name: f,
          path: path.join(workspaceRoot, f),
          mtime: fs.statSync(path.join(workspaceRoot, f)).mtime,
        }))
        .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())[0].path;
      
      // List contents of .vsix package using vsce
      try {
        const output = execSync('npx vsce ls', {
          cwd: workspaceRoot,
          encoding: 'utf-8',
        });
        vsixContents = output.split('\n').map(line => line.trim()).filter(Boolean);
      } catch (error) {
        console.error('Failed to list .vsix contents:', error);
        throw error;
      }
    });

    it('should include tree-sitter.wasm in package', () => {
      if (!vsixPath) {
        console.warn('Skipping test: no .vsix file found');
        return;
      }
      
      const wasmInPackage = vsixContents.some(line => 
        line.includes('dist/tree-sitter.wasm') || line.endsWith('tree-sitter.wasm')
      );
      
      expect(
        wasmInPackage,
        'tree-sitter.wasm not found in .vsix package. Check .vscodeignore patterns.'
      ).toBe(true);
    });

    it('should include tree-sitter-python.wasm in package', () => {
      if (!vsixPath) {
        console.warn('Skipping test: no .vsix file found');
        return;
      }
      
      const wasmInPackage = vsixContents.some(line => 
        line.includes('dist/tree-sitter-python.wasm') || line.endsWith('tree-sitter-python.wasm')
      );
      
      expect(
        wasmInPackage,
        'tree-sitter-python.wasm not found in .vsix package. Check .vscodeignore patterns.'
      ).toBe(true);
    });

    it('should include tree-sitter-rust.wasm in package', () => {
      if (!vsixPath) {
        console.warn('Skipping test: no .vsix file found');
        return;
      }
      
      const wasmInPackage = vsixContents.some(line => 
        line.includes('dist/tree-sitter-rust.wasm') || line.endsWith('tree-sitter-rust.wasm')
      );
      
      expect(
        wasmInPackage,
        'tree-sitter-rust.wasm not found in .vsix package. Check .vscodeignore patterns.'
      ).toBe(true);
    });

    it('should include all required WASM files in package', () => {
      if (!vsixPath) {
        console.warn('Skipping test: no .vsix file found');
        return;
      }
      
      const missingFiles: string[] = [];
      
      for (const wasmFile of requiredWasmFiles) {
        const wasmInPackage = vsixContents.some(line => 
          line.includes(`dist/${wasmFile}`) || line.endsWith(wasmFile)
        );
        
        if (!wasmInPackage) {
          missingFiles.push(wasmFile);
        }
      }
      
      expect(
        missingFiles,
        `Missing WASM files in .vsix package: ${missingFiles.join(', ')}. Check .vscodeignore patterns.`
      ).toHaveLength(0);
    });

    it('should NOT include .map files in package', () => {
      if (!vsixPath) {
        console.warn('Skipping test: no .vsix file found');
        return;
      }
      
      const mapFiles = vsixContents.filter(line => line.endsWith('.map'));
      
      expect(
        mapFiles,
        `.map files found in .vsix package: ${mapFiles.join(', ')}. These should be excluded by .vscodeignore.`
      ).toHaveLength(0);
    });

    it('should have reasonable package size', () => {
      if (!vsixPath) {
        console.warn('Skipping test: no .vsix file found');
        return;
      }
      
      const stats = fs.statSync(vsixPath);
      const sizeMB = stats.size / (1024 * 1024);
      
      // Package should be between 5MB and 20MB (sanity check)
      expect(sizeMB).toBeGreaterThan(5);
      expect(sizeMB).toBeLessThan(20);
      
      console.log(`Package size: ${sizeMB.toFixed(2)} MB`);
    });
  });

  describe('build configuration validation', () => {
    it('should have .vscodeignore that includes WASM files', () => {
      const vscodeignorePath = path.join(process.cwd(), '.vscodeignore');
      expect(fs.existsSync(vscodeignorePath), '.vscodeignore file not found').toBe(true);
      
      const content = fs.readFileSync(vscodeignorePath, 'utf-8');
      
      // Should NOT exclude .wasm files
      const excludesWasm = content.split('\n').some(line => {
        const trimmed = line.trim();
        // Check for patterns that would exclude WASM files
        return (
          trimmed === '*.wasm' ||
          trimmed === '**/*.wasm' ||
          trimmed === 'dist/*.wasm'
        );
      });
      
      expect(
        excludesWasm,
        '.vscodeignore should NOT exclude .wasm files'
      ).toBe(false);
    });

    it('should have esbuild.js with WASM file loader', () => {
      const esbuildPath = path.join(process.cwd(), 'esbuild.js');
      expect(fs.existsSync(esbuildPath), 'esbuild.js file not found').toBe(true);
      
      const content = fs.readFileSync(esbuildPath, 'utf-8');
      
      // Should have .wasm file loader
      expect(
        content,
        'esbuild.js should include .wasm file loader'
      ).toContain("'.wasm': 'file'");
      
      // Should have copyWasmFiles function
      expect(
        content,
        'esbuild.js should have copyWasmFiles function'
      ).toContain('copyWasmFiles');
    });

    it('should have package.json with WASM dependencies', () => {
      const packageJsonPath = path.join(process.cwd(), 'package.json');
      expect(fs.existsSync(packageJsonPath), 'package.json file not found').toBe(true);
      
      const content = fs.readFileSync(packageJsonPath, 'utf-8');
      const packageJson = JSON.parse(content);
      
      // Should have web-tree-sitter
      expect(
        packageJson.dependencies['web-tree-sitter'],
        'package.json should include web-tree-sitter dependency'
      ).toBeDefined();
      
      // Should have tree-sitter-wasms
      expect(
        packageJson.dependencies['tree-sitter-wasms'],
        'package.json should include tree-sitter-wasms dependency'
      ).toBeDefined();
      
      // Should NOT have native tree-sitter dependencies
      expect(
        packageJson.dependencies['tree-sitter'],
        'package.json should NOT include native tree-sitter dependency'
      ).toBeUndefined();
      
      expect(
        packageJson.dependencies['tree-sitter-python'],
        'package.json should NOT include native tree-sitter-python dependency'
      ).toBeUndefined();
      
      expect(
        packageJson.dependencies['tree-sitter-rust'],
        'package.json should NOT include native tree-sitter-rust dependency'
      ).toBeUndefined();
    });
  });
});
