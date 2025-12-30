# MCP Modularization Plan

## Status: Partially Implemented

This document outlines the plan to modularize the MCP server for better maintainability and testability.

## Problem Statement

Currently, `mcpServer.ts` is monolithic:
- All tool definitions are inline (~1400 lines)
- Tool validation and execution logic mixed together
- Difficult to test individual tools in isolation
- Hard to add new tools without modifying a large file

## Proposed Solution

### Three-Module Architecture

1. **toolRegistry.ts**
   - Central registry for all MCP tools
   - Manages tool metadata and lifecycle
   - Provides statistics and introspection

2. **toolHandlers.ts**
   - Execution logic for each tool
   - Wraps McpWorkerHost invocations
   - Formats responses consistently
   - Measures execution time

3. **toolDefinitions.ts**
   - Declarative tool definitions
   - Separates WHAT from HOW
   - Contains descriptions, schemas, and annotations
   - Easy to scan and understand available tools

### Integration Challenges

**Current Blocker**: The MCP SDK's `registerTool` method has a complex handler signature that doesn't align cleanly with our abstraction. The handler receives `RequestHandlerExtra` which includes server context.

**Options**:
1. **Wrapper Approach** (tried): Wrap handler calls, but type inference becomes complex
2. **Direct Integration**: Use the modules but don't abstract `registerTool`
3. **Wait for SDK Update**: Proposed cleaner API in MCP SDK v2

### Current State

The three modules exist and are type-safe, but not yet integrated into `mcpServer.ts`. They can be integrated incrementally:

```typescript
// In mcpServer.ts future refactor:
import { ToolRegistry } from './toolRegistry';
import { ToolHandlers } from './toolHandlers';
import { createToolDefinitions } from './toolDefinitions';

const handlers = new ToolHandlers(workerHost);
const registry = new ToolRegistry();

// Register all tools
const definitions = createToolDefinitions(handlers, setWorkspaceHandler);
for (const def of definitions) {
  registry.register(def);
}

// Manually register with MCP server (avoiding type issues)
registry.registerWithServer(server);
```

## Benefits After Integration

- **Reduced Complexity**: Each file under 500 lines
- **Better Testing**: Test handlers independently from server setup
- **Easier Onboarding**: Clear separation of concerns
- **Tool Discovery**: Registry provides introspection
- **Type Safety**: Centralized type definitions

## Next Steps

1. ⏳ Create modular structure
2. ⏳ Refactor `mcpServer.ts` to use new modules
3. ⏳ Add unit tests for toolHandlers
4. ⏳ Add integration tests for registry
5. ⏳ Update AGENTS.md with new architecture

## Related Files

- `src/mcp/toolRegistry.ts`
- `src/mcp/toolHandlers.ts`
- `src/mcp/toolDefinitions.ts`
- `src/mcp/mcpServer.ts` (to be refactored)
- `src/mcp/types.ts` (updated with limits)
