# Migration Notice: MCP Debug Logging Changes

## Important Privacy Update

**Version**: Unreleased (upcoming)  
**Priority**: P1 - Security/Privacy  
**Status**: Breaking Change for Debug Logging Behavior

## What Changed?

MCP server debug logging now requires **explicit user consent** and implements **automatic log rotation**.

### Before (Security Risk)

- ✗ Debug logs were **always created** at `~/mcp-debug.log`
- ✗ Logs contained project paths and environment details **without consent**
- ✗ **No size limits** - logs could grow indefinitely
- ✗ **No rotation** - old logs accumulated forever

### After (Privacy-First)

- ✓ Debug logs are **disabled by default**
- ✓ Requires **explicit opt-in** via `graph-it-live.enableMcpDebugLogging`
- ✓ **Automatic rotation** at 5MB per file
- ✓ **Limited retention** - keeps only last 2 files (10MB total)

## Action Required

### For Existing Users

If you have existing `~/mcp-debug.log` files:

```bash
# Check if you have debug logs
ls -lh ~/mcp-debug.log*

# Optional: Review logs before deletion
cat ~/mcp-debug.log

# Remove logs to reclaim disk space and improve privacy
rm ~/mcp-debug.log ~/mcp-debug.log.1
```

### For Users Who Need Debug Logs

If you're actively troubleshooting MCP issues:

1. **Enable the new setting**:
   - Open VS Code Settings (`Cmd+,` or `Ctrl+,`)
   - Search for "MCP Debug Logging"
   - Check "Enable Mcp Debug Logging"

2. **Restart MCP server**:
   - Reload VS Code window or
   - Toggle `graph-it-live.enableMcpServer` off/on

3. **After troubleshooting**:
   - **Disable the setting** to stop log accumulation
   - Delete log files to free disk space

## Why This Change?

### Privacy Concerns

Debug logs may expose:
- Full project paths (may contain usernames, organization names)
- File and directory structure
- Import relationships and code organization
- Environment variables and workspace configuration

### Security Risks

- **Shared machines**: Other users could access your logs
- **Backups**: Logs may be included in automated backups
- **Support scenarios**: Users may share logs containing sensitive info
- **Compliance**: May violate GDPR, corporate security policies

## Settings Reference

### New Setting

```json
{
  "graph-it-live.enableMcpDebugLogging": false
}
```

**Default**: `false` (privacy-friendly)  
**When to enable**: Only during active troubleshooting  
**When to disable**: Immediately after collecting necessary logs

### Existing Setting (Unchanged)

```json
{
  "graph-it-live.enableMcpServer": false
}
```

**Purpose**: Master switch for MCP functionality  
**Default**: `false` (opt-in for AI features)

## Log File Details

### Location

- Current log: `~/mcp-debug.log`
- Backup log: `~/mcp-debug.log.1`

### Rotation Behavior

When `mcp-debug.log` exceeds 5MB:
1. Delete `mcp-debug.log.1` (if exists)
2. Rename `mcp-debug.log` → `mcp-debug.log.1`
3. Create new `mcp-debug.log`

### Size Limits

- Max per file: 5MB
- Max total: 10MB (2 files)
- Old logs automatically deleted

## Frequently Asked Questions

### Q: Will this affect MCP functionality?

**A**: No. The MCP server continues to write diagnostic messages to stderr (required for the protocol). This change only affects the optional file-based debug logging.

### Q: Can I still troubleshoot MCP issues?

**A**: Yes. Simply enable `graph-it-live.enableMcpDebugLogging` when needed, collect logs, then disable it.

### Q: What happens to my existing log files?

**A**: They remain unchanged. You can manually delete them to reclaim disk space.

### Q: Is this a breaking change?

**A**: Only for debug logging behavior. The MCP server functionality itself is unchanged.

### Q: How do I know if debug logging is enabled?

**A**: Check VS Code settings or look for the `~/mcp-debug.log` file being updated.

## Additional Resources

- [MCP Debug Logging Security Guide](MCP_DEBUG_LOGGING_SECURITY.md)
- [Extension Settings Documentation](../README.md#configuration)
- [Changelog](../changelog.md)

## Support

If you have questions or concerns about this change:
- Open an issue on GitHub
- Check the [Security Guide](MCP_DEBUG_LOGGING_SECURITY.md)
- Review VS Code's [MCP documentation](https://code.visualstudio.com/api/extension-guides/ai/mcp)
