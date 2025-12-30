# MCP Server Debug Logging - Security & Privacy Guide

## Overview

The MCP server provides detailed debug logging for troubleshooting, but this feature requires explicit user consent due to privacy implications.

## Privacy Concerns

Debug logs may contain:
- **Project paths**: Full file system paths exposing project structure
- **File names**: Names of source files being analyzed
- **Environment variables**: Workspace configuration details
- **Dependency relationships**: Internal code structure information

## Security Risks

1. **Shared Machines**: Log files persist in home directory, accessible to other users
2. **Backups**: Logs may be included in automated backups, exposing project info
3. **Support Scenarios**: Users may inadvertently share logs containing sensitive paths
4. **Long-term Accumulation**: Without rotation, logs can grow unbounded

## Implementation

### Opt-In Requirement

```typescript
const DEBUG_MCP_ENABLED = process.env.DEBUG_MCP === 'true';
```

**Default**: `false` - No logging unless explicitly enabled

### VS Code Setting

```json
{
  "graph-it-live.enableMcpDebugLogging": false
}
```

Users must explicitly enable this setting in VS Code preferences.

### Automatic Log Rotation

To prevent unbounded disk usage:

- **Max file size**: 5MB per log file
- **File retention**: Keeps last 2 files (current + backup)
- **Location**: `~/mcp-debug.log` and `~/mcp-debug.log.1`
- **Behavior**: When current log exceeds 5MB:
  1. Delete `mcp-debug.log.1` (if exists)
  2. Rename `mcp-debug.log` → `mcp-debug.log.1`
  3. Create new `mcp-debug.log`

### Privacy-First Design

```typescript
/**
 * Write debug log only if explicitly enabled
 * Privacy: Prevents exposure of project paths without consent
 */
function debugLog(...args: unknown[]): void {
  const message = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
  
  // Always write to stderr (required for MCP protocol)
  console.error(message);
  
  // File logging is OPT-IN only
  if (!DEBUG_MCP_ENABLED) return;
  
  try {
    rotateLogIfNeeded();
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${message}\n`;
    fs.appendFileSync(DEBUG_LOG_PATH, line);
  } catch {
    // Fail silently to avoid crashes on permission issues
  }
}
```

## User Guidelines

### When to Enable Debug Logging

✅ **Enable when**:
- Troubleshooting MCP connection issues
- Reporting bugs to extension authors
- Investigating performance problems
- Guided by support team

❌ **Disable after**:
- Issue is resolved
- Sufficient logs collected for bug report
- Testing completed

### How to Enable

1. Open VS Code Settings (`Cmd+,` or `Ctrl+,`)
2. Search for "MCP Debug Logging"
3. Check "Enable Mcp Debug Logging"
4. Restart the MCP server (reload window or toggle setting)

### How to Clean Up Logs

```bash
# Remove all MCP debug logs
rm ~/mcp-debug.log ~/mcp-debug.log.1
```

## Compliance Notes

- **GDPR**: Log files may contain personal data (file paths with usernames)
- **Corporate Policies**: Some organizations prohibit logging source code paths
- **Data Minimization**: Only log when necessary for troubleshooting

## Related Settings

- `graph-it-live.enableMcpServer`: Master switch for MCP functionality
- `graph-it-live.enableMcpDebugLogging`: Opt-in for detailed logging

## Testing

See `tests/mcp/mcpLogRotation.test.ts` for:
- Rotation logic verification
- Privacy default checks
- File size limit enforcement
- Backup file management

## References

- [VS Code MCP Documentation](https://code.visualstudio.com/api/extension-guides/ai/mcp)
- [Model Context Protocol Spec](https://modelcontextprotocol.io/)
- Issue: P1 Security/Privacy - MCP logs without opt-in
