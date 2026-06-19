import { beforeEach, describe, expect, it, vi } from 'vitest';

// Inline vscode mock — mirrors pattern from CommandRegistrationService.test.ts
vi.mock('vscode', () => {
  // Minimal EventEmitter mock tracking fire calls
  class EventEmitter {
    private listeners: Array<() => void> = [];
    fire = vi.fn(() => {
      for (const l of this.listeners) l();
    });
    event = (listener: () => void) => {
      this.listeners.push(listener);
      return { dispose: vi.fn() };
    };
    dispose = vi.fn();
  }

  // Minimal Uri mock
  class Uri {
    constructor(public fsPath: string) {}
    static file(p: string) { return new Uri(p); }
    static joinPath(base: Uri, ...segments: string[]) {
      return new Uri([base.fsPath, ...segments].join('/'));
    }
  }

  const getConfiguration = vi.fn(() => ({
    get: vi.fn((_key: string, defaultVal: unknown) => defaultVal),
  }));

  const lm = {
    registerMcpServerDefinitionProvider: vi.fn(() => ({ dispose: vi.fn() })),
  };

  const McpStdioServerDefinition = vi.fn(function (
    this: { label: string; command: string; args: string[]; env: Record<string, unknown>; cwd?: unknown },
    label: string,
    command: string,
    args: string[],
    env: Record<string, unknown>
  ) {
    this.label = label;
    this.command = command;
    this.args = args;
    this.env = env;
  });

  return {
    EventEmitter,
    Uri,
    Disposable: {
      from: (...disposables: { dispose: () => unknown }[]) => ({
        dispose: () => disposables.forEach((d) => d.dispose()),
      }),
    },
    workspace: {
      getConfiguration,
      onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
    },
    window: {
      createOutputChannel: vi.fn(() => ({
        appendLine: vi.fn(),
        show: vi.fn(),
        dispose: vi.fn(),
      })),
    },
    lm,
    McpStdioServerDefinition,
    __mocks: {
      getConfiguration,
      lm,
      McpStdioServerDefinition,
    },
  };
});

import * as vscode from 'vscode';
import { McpServerProvider } from '../../src/extension/McpServerProvider';

// Helper to build a WorkspaceFolder-like object
function makeFolder(fsPath: string): vscode.WorkspaceFolder {
  return {
    uri: { fsPath } as vscode.Uri,
    name: fsPath,
    index: 0,
  };
}

// Helper to build an extensionUri-like object
function makeExtensionUri(fsPath: string): vscode.Uri {
  return { fsPath } as unknown as vscode.Uri;
}

describe('McpServerProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('workspaceRoot getter returns workspaceFolder.uri.fsPath', () => {
    const folder = makeFolder('/workspace/my-project');
    const provider = new McpServerProvider({
      extensionUri: makeExtensionUri('/ext'),
      workspaceFolder: folder,
    });

    expect(provider.workspaceRoot).toBe('/workspace/my-project');
  });

  it('updateWorkspaceFolder with SAME path is a no-op (emitter not fired)', () => {
    const folder = makeFolder('/workspace/project');
    const provider = new McpServerProvider({
      extensionUri: makeExtensionUri('/ext'),
      workspaceFolder: folder,
    });

    // Capture the emitter via the event subscription
    let fired = false;
    // Access internal emitter through the event exposed after register — instead,
    // spy via notifyChange to confirm fire is isolated: use the public API.
    // We spy on notifyChange indirectly: call updateWorkspaceFolder with same path,
    // then verify workspaceRoot has not changed AND the event was not triggered.
    // Since we cannot directly access the private emitter, we subscribe via register.

    const context = {
      subscriptions: { push: vi.fn() },
    } as unknown as vscode.ExtensionContext;

    // We skip register here; instead we expose the event by tapping onDidChange via a
    // custom holder. The provider exposes didChangeEmitter.event via the register call.
    // Simpler: use notifyChange as baseline then check update-same does NOT fire.
    let changeCount = 0;

    // Patch the internal emitter's fire via the provider's notifyChange to calibrate
    const originalNotify = provider.notifyChange.bind(provider);
    const notifySpy = vi.spyOn(provider, 'notifyChange').mockImplementation(() => {
      changeCount++;
      originalNotify();
    });

    // updateWorkspaceFolder with the same path — must not fire
    provider.updateWorkspaceFolder(makeFolder('/workspace/project'));
    expect(changeCount).toBe(0);
    expect(provider.workspaceRoot).toBe('/workspace/project');

    notifySpy.mockRestore();
  });

  it('updateWorkspaceFolder with DIFFERENT folder updates workspaceRoot', () => {
    const initialFolder = makeFolder('/workspace/old');
    const provider = new McpServerProvider({
      extensionUri: makeExtensionUri('/ext'),
      workspaceFolder: initialFolder,
    });

    provider.updateWorkspaceFolder(makeFolder('/workspace/new'));

    expect(provider.workspaceRoot).toBe('/workspace/new');
  });

  it('updateWorkspaceFolder with DIFFERENT folder fires onDidChangeMcpServerDefinitions event', () => {
    const initialFolder = makeFolder('/workspace/alpha');
    const provider = new McpServerProvider({
      extensionUri: makeExtensionUri('/ext'),
      workspaceFolder: initialFolder,
    });

    // Register so the provider wires up its event to vscode.lm
    const context = {
      subscriptions: { push: vi.fn() },
    } as unknown as vscode.ExtensionContext;
    provider.register(context);

    // Extract the provider object passed to registerMcpServerDefinitionProvider
    const lmMock = (vscode as unknown as {
      __mocks: { lm: { registerMcpServerDefinitionProvider: ReturnType<typeof vi.fn> } };
    }).__mocks.lm;
    const providerArg = lmMock.registerMcpServerDefinitionProvider.mock.calls[0][1] as {
      onDidChangeMcpServerDefinitions: (listener: () => void) => { dispose: () => void };
    };

    // Subscribe a listener to the event exposed by the provider
    const firedEvents: number[] = [];
    providerArg.onDidChangeMcpServerDefinitions(() => { firedEvents.push(1); });

    // Trigger with a DIFFERENT folder — must fire the event
    provider.updateWorkspaceFolder(makeFolder('/workspace/beta'));

    expect(firedEvents).toHaveLength(1);
    expect(provider.workspaceRoot).toBe('/workspace/beta');

    // Trigger again with the SAME folder — must NOT fire again
    provider.updateWorkspaceFolder(makeFolder('/workspace/beta'));
    expect(firedEvents).toHaveLength(1);
  });
});
