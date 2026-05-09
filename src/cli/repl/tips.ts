/**
 * REPL Tips
 *
 * Step-specific tips shown at each prompt to guide users through the REPL.
 * Tips rotate deterministically per REPL cycle — no randomness, fully testable.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

/**
 * Tips keyed by step. Each array rotates round-robin via `getTip(key, counter)`.
 */
const COMMAND_TIPS: Record<string, string[]> = {
  'trace.file': [
    'Select the entry-point (e.g. index.ts) to trace the full call chain from the top.',
    'Pick any file — the tracer will follow imports recursively from the symbol you choose.',
    'Tip: for libraries, select the main export file to map all outbound call paths.',
  ],
  'trace.symbol': [
    'Leave empty to analyze the whole file structure instead of a single symbol.',
    'Type to filter symbols — e.g. "handle", "process", "init". Pick one to trace its callers.',
    'Symbol autocomplete is extracted from the file\'s AST. Empty = full-file mode.',
  ],
  'checkDeps.file': [
    'Outgoing = what this file imports · Incoming = who imports this file.',
    'Use "Both" to get a full picture; "Incoming only" to find who depends on this module.',
    'High incoming count = high-impact file. Changes here ripple across many dependents.',
  ],
  'cycles.file': [
    'Cycles create brittle coupling. Files in a cycle cannot be safely refactored independently.',
    'Pick a file suspected of being in a circular dependency chain to inspect all cycle members.',
    'Security tip: cycles in auth or config modules can hide initialization-order vulnerabilities.',
  ],
  'architecture.start': [
    'Use Mermaid format (/format mermaid) to get a visual dependency diagram.',
    'Architecture gives a workspace-wide view: nodes are files, edges are import relationships.',
    'Architect tip: run /check (dead code) after /architecture to find unused modules.',
  ],
  'check.start': [
    'Dead code check finds exported symbols that are never imported anywhere in the project.',
    'Run this regularly before releases to keep the bundle lean and reduce attack surface.',
    'QA tip: unused exports often indicate forgotten feature flags or abandoned refactors.',
  ],
  'pathIn.file': [
    'Path-in shows who imports this file — useful for impact analysis before refactoring.',
    'If path-in returns many files, changing this module will affect a large surface area.',
    'Security tip: modules imported by many entry points should be hardened first.',
  ],
  'result.trace': [
    'Next: run /check-dependencies to see who depends on the traced file.',
    'Next: run /cycles to check if the traced symbol is part of a circular dependency.',
    'Trace result shows call depth — deep chains (>10) may indicate tight coupling.',
  ],
  'result.check-dependencies': [
    'Next: run /trace to dive into a specific symbol within this file.',
    'Next: run /cycles to find circular dependency chains involving this file.',
    'High outgoing count = this file imports many things. Consider splitting responsibilities.',
  ],
  'result.cycles': [
    'Next: run /check to find dead code that may be entangled in the cycle.',
    'Next: run /check-dependencies to understand which files are involved.',
    'Breaking cycles often requires extracting shared types into a separate module.',
  ],
  'result.architecture': [
    'Next: run /check to find unused exports across the whole workspace.',
    'Next: run /trace on a heavily-connected file to understand its role.',
    'Save as Mermaid (/save) to embed this diagram in your documentation.',
  ],
  'result.check': [
    'Next: run /architecture to see the full dependency picture.',
    'Next: run /check-dependencies on a flagged file to understand its context.',
    'Removing dead exports reduces the public API surface and improves maintainability.',
  ],
  'result.summary': [
    'Next: run /architecture for a workspace-wide dependency map.',
    'Next: run /trace on a key file to explore its call hierarchy.',
    'Summary includes codemap (TOON format) — useful for LLM context.',
  ],
  'result.explain': [
    'Next: run /check-dependencies to see who imports this file.',
    'Next: run /trace to follow a specific symbol across the codebase.',
    'Explain reveals intra-file call hierarchy — cycles inside a file appear here.',
  ],
  'result.path': [
    'Next: run /check-dependencies for both incoming and outgoing directions.',
    'Next: run /cycles to check if any file in the graph creates a circular dependency.',
    'The dependency graph shows transitive imports — deeper = more tightly coupled.',
  ],
  'general': [
    'Type / to browse commands. Start typing a keyword (e.g. "deps", "arch") to filter.',
    'Use /format mermaid then /architecture for a visual project map.',
    'Set a working file with /file to make /summary and /check context-aware.',
    'Use /path src/ to narrow the workspace scope to a specific subdirectory.',
    '/command lets you run raw CLI args: e.g. "trace src/cli/index.ts#run --format json".',
    'After any analysis, type / in the post-result menu to see smart follow-up suggestions.',
    'Save results with /save — Mermaid exports as .mmd, JSON as .json, Markdown as .md.',
  ],
};

/**
 * Persona-tagged tips that rotate across all roles.
 * Each tip hints at features relevant to a specific professional perspective.
 */
const PERSONA_TIPS: string[] = [
  '👩‍💻 Developer: Use /trace to follow execution from an entry point symbol.',
  '🏛  Architect: Use /architecture + Mermaid to map the full dependency structure.',
  '🔒 Security: Use /cycles to find circular deps that may hide init-order vulnerabilities.',
  '🔒 Security: Use /check to eliminate unused exports that expand your attack surface.',
  '🧪 QA: Use /check-dependencies to understand the blast radius before a refactor.',
  '🧪 QA: Use /cycles to detect brittle circular coupling before regression testing.',
  '📊 Data: Use /summary --format toon to get a compact AI-friendly structural overview.',
  '📋 Functional: Use /summary to get a human-readable overview of any module.',
  '🏛  Architect: High incoming-dependency count on a file = high-risk change zone.',
  '👩‍💻 Developer: Use /check (dead code) before PRs to keep exports intentional.',
];

/**
 * Return the tip for `key` at position `counter % tips.length`.
 * Falls back to `''` if the key is unknown or has no tips.
 */
export function getTip(key: string, counter: number): string {
  const tips = COMMAND_TIPS[key];
  if (!tips || tips.length === 0) return '';
  return tips[counter % tips.length];
}

/**
 * Return the persona tip at position `counter % PERSONA_TIPS.length`.
 */
export function getPersonaTip(counter: number): string {
  return PERSONA_TIPS[counter % PERSONA_TIPS.length];
}
