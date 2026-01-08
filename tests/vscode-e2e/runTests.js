"use strict";
/**
 * VSCode Extension E2E Tests
 *
 * These tests run the extension in a real VSCode instance.
 * They verify:
 * - Extension activation
 * - Command execution
 * - Webview creation
 * - File analysis functionality
 *
 * Usage:
 * - `npm run test:vscode` - Test from source (development mode)
 * - `npm run test:vscode:vsix` - Test from packaged .vsix (production mode)
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const path = __importStar(require("node:path"));
const fs = __importStar(require("node:fs"));
const test_electron_1 = require("@vscode/test-electron");
async function main() {
    const useVsix = process.argv.includes('--vsix');
    try {
        // The folder containing the Extension Manifest package.json
        const extensionDevelopmentPath = path.resolve(__dirname, '../../');
        // The path to test runner
        const extensionTestsPath = path.resolve(__dirname, './suite/index');
        // Use fixtures as workspace root to allow tests to access all test projects
        // Use absolute path from extension root to avoid path resolution issues
        const workspaceRoot = path.resolve(extensionDevelopmentPath, 'tests/fixtures');
        const launchArgs = [
            workspaceRoot,
            '--disable-extensions', // Disable other extensions for clean testing
        ];
        if (useVsix) {
            // Test from packaged .vsix file (production mode)
            const vsixFiles = fs.readdirSync(extensionDevelopmentPath)
                .filter(f => f.endsWith('.vsix'))
                .sort()
                .reverse(); // Get latest
            if (vsixFiles.length === 0) {
                throw new Error('No .vsix file found. Run `npm run package` first.');
            }
            const vsixPath = path.resolve(extensionDevelopmentPath, vsixFiles[0]);
            console.log(`📦 Testing packaged extension: ${vsixFiles[0]}`);
            // When testing .vsix, we still need extensionDevelopmentPath for the test runner
            // but the extension is loaded from the installed .vsix
            await (0, test_electron_1.runTests)({
                extensionDevelopmentPath,
                extensionTestsPath,
                launchArgs: [
                    ...launchArgs,
                    `--install-extension=${vsixPath}`,
                ],
            });
        }
        else {
            // Test from source (development mode)
            console.log('🔧 Testing extension from source (development mode)');
            await (0, test_electron_1.runTests)({
                extensionDevelopmentPath,
                extensionTestsPath,
                launchArgs,
            });
        }
        console.log('✅ All tests passed!');
    }
    catch (err) {
        console.error('❌ Failed to run tests:', err);
        process.exit(1);
    }
}
main();
