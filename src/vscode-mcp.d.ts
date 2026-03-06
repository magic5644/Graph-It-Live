/**
 * Type augmentation for VS Code MCP APIs (proposed in VS Code 1.99+).
 *
 * These types are not yet in @types/vscode@1.96.0; runtime availability
 * is guarded by feature-detection in McpServerProvider.ts.
 */

declare module 'vscode' {

  // ------------------------------------------------------------------
  // MCP server definitions
  // ------------------------------------------------------------------

  interface McpServerDefinition {
    readonly label: string;
  }

  class McpStdioServerDefinition implements McpServerDefinition {
    readonly label: string;
    readonly command: string;
    readonly args?: readonly string[];
    readonly env?: Record<string, string | number | null>;
    cwd?: Uri;

    constructor(
      label: string,
      command: string,
      args?: string[],
      env?: Record<string, string | number | null>,
      version?: string,
    );
  }

  // ------------------------------------------------------------------
  // MCP server definition provider
  // ------------------------------------------------------------------

  interface McpServerDefinitionProvider {
    onDidChangeMcpServerDefinitions: Event<void>;
    provideMcpServerDefinitions(token?: CancellationToken): ProviderResult<McpServerDefinition[]>;
    resolveMcpServerDefinition?(definition: McpServerDefinition, token?: CancellationToken): ProviderResult<McpServerDefinition>;
  }

  // ------------------------------------------------------------------
  // lm namespace extension
  // ------------------------------------------------------------------

  namespace lm {
    function registerMcpServerDefinitionProvider(
      id: string,
      provider: McpServerDefinitionProvider,
    ): Disposable;
  }
}
