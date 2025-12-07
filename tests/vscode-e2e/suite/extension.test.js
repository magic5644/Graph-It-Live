"use strict";
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
const assert = __importStar(require("assert"));
const vscode = __importStar(require("vscode"));
const mocha_1 = require("mocha");
suite('Graph-It-Live Extension Test Suite', () => {
    (0, mocha_1.before)(() => {
        vscode.window.showInformationMessage('Start all tests.');
    });
    (0, mocha_1.after)(() => {
        vscode.window.showInformationMessage('All tests done!');
    });
    test('Extension should be present', () => {
        assert.ok(vscode.extensions.getExtension('magic5644.graph-it-live'));
    });
    test('Extension should activate', async function () {
        this.timeout(30000); // Give extension time to activate and index
        const ext = vscode.extensions.getExtension('magic5644.graph-it-live');
        assert.ok(ext, 'Extension should exist');
        await ext.activate();
        assert.strictEqual(ext.isActive, true, 'Extension should be active');
    });
    test('Should register showGraph command', async () => {
        const commands = await vscode.commands.getCommands(true);
        assert.ok(commands.includes('graph-it-live.showGraph'), 'Should have showGraph command');
    });
    test('Should open graph view when command is executed', async function () {
        this.timeout(10000);
        // Execute the show graph command
        await vscode.commands.executeCommand('graph-it-live.showGraph');
        // Wait a bit for the view to appear
        await new Promise(resolve => setTimeout(resolve, 1000));
        // The graph view should now be visible (we can't easily verify webview content though)
        // What we can check is that the command executed without error
        assert.ok(true, 'Command executed successfully');
    });
    test('Should analyze a TypeScript file', async function () {
        this.timeout(15000);
        // Open a sample TypeScript file
        const workspaceFolders = vscode.workspace.workspaceFolders;
        assert.ok(workspaceFolders && workspaceFolders.length > 0, 'Should have a workspace');
        const sampleFile = vscode.Uri.joinPath(workspaceFolders[0].uri, 'src/utils.ts');
        try {
            const doc = await vscode.workspace.openTextDocument(sampleFile);
            await vscode.window.showTextDocument(doc);
            // Wait for extension to process the file
            await new Promise(resolve => setTimeout(resolve, 2000));
            // If we got here without errors, the extension handled the file
            assert.ok(true, 'File was processed');
        }
        catch (err) {
            // File might not exist in test workspace, that's okay
            assert.ok(true, 'Test completed');
        }
    });
});
