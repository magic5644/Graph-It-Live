---
paths:
  - "src/**/*.{ts,tsx,js,mjs}"
  - "tests/**/*.{ts,tsx,js,mjs}"
  - "esbuild.js"
  - "package*.json"
---

# SonarQube Quality Gate

After modifying first-party source, analyze every modified file with configured SonarQube tooling.

1. Run `sonarqube_analyze_file` on every modified file when tool is available.
2. Run editor diagnostics on same files to collect SonarQube and compile findings.
3. Fix every new security, quality, and complexity issue caused by change.
4. Re-run analysis and diagnostics after fixes.
5. Stop only when modified files report no errors or remaining finding has explicit justified suppression.

For many independent files, analyze concurrently and consolidate findings before editing.

Security focus:

- Treat paths derived from module specifiers, imports, MCP payloads, or user input as untrusted.
- Resolve final path and verify it remains inside intended workspace root before file I/O (CWE-22 / OWASP A01).
- Never pass unsanitized source-derived input directly to filesystem APIs.

If SonarQube tooling is unavailable, report that limitation; still run configured lint, typecheck, tests, and editor diagnostics. Do not claim SonarQube passed.

## Dependency Security

- After adding or updating dependencies, run `npm audit` and configured Snyk analysis when available.
- Fix findings introduced by change, rescan after fixes, and report unresolved findings explicitly.
- Do not run automatic audit fixes blindly when they may introduce breaking upgrades.
