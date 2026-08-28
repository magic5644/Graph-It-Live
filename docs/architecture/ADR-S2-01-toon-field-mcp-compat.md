# ADR-S2-01: MCP Compatibility of the `toon` Field — Fix Token-Savings Mechanism

## Status

Accepted

## Context

`query_natural_language` (MCP tool, `src/mcp/tools/query.ts`) declares an output field `toon?: string` that is supposed to hold a TOON encoding (header+rows, documented in `docs/architecture/TOON_FORMAT.md`, promised in the CHANGELOG: *"MCP tool `query_natural_language` ... Returns a TOON subgraph"*). In reality, the `outputFormat === 'toon'` branch returns a **JSON passthrough** — not real TOON. The fix introduces `encodeCompositeAsToon()`, which produces real TOON (header+rows+meta line) under the **same field name** `toon`.

Evidence collected (git + CHANGELOG):
- `src/mcp/tools/query.ts` already exists in tags `v1.9.0` → `v1.9.8` (9 tagged releases) — the tool has non-trivial production exposure, not an unshipped feature.
- `MCP_TOOL_VERSION` (`src/mcp/types.ts:28`) is a static constant `"1.0.0"` **never bumped** since its introduction (verified via `git log -p --follow`) — there is no living per-tool versioning practice in this project; creating one ad hoc for this single fix would send a misleading signal (all other tools would remain at 1.0.0 indefinitely).
- `package.json.version` = `0.0.1` (not representative — bumped by CI at publish time, per project memory), and the package does not appear on the public npm registry (`npm view` → 404): no verifiable external distribution channel outside the VS Code bundle (extension `publisher: magic5644`).
- The CHANGELOG already documents TOON behavior as the expected contract — the current JSON passthrough is a **non-conformance with an already-published contract**, not a new behavior that would be broken.

Separately (out of scope for this ADR): `QueryResult.toon` in `src/analyzer` / `shared/query-types.ts` is renamed to `.json` — internal usage only, no external contract, no compat risk.

## Decision

**Option 1 retained: fix in place, no field rename.** `QueryNaturalLanguageResult.toon` keeps its name; its content changes from JSON-passthrough to real TOON. The change is communicated via an explicit CHANGELOG "Fixed" entry + migration note, and a one-off bump of `MCP_TOOL_VERSION` (`1.0.0` → `1.1.0`) as a minor version signal, even though this practice was not previously systematic. **Note (Marine, devil review): this bump has no version-negotiation effect on the MCP protocol side — the MCP SDK neither reads nor exposes `MCP_TOOL_VERSION` to a client for routing or compat purposes. It is an informational marker in code/CHANGELOG only, not a protocol mechanism.**

Justification by criterion:

1. **The field never honored its documented contract.** The CHANGELOG has promised TOON since the tool's introduction; a client that does `JSON.parse(result.toon)` today is exploiting buggy behavior, not a stable contract. Renaming or formally versioning it would enshrine a bug as if it were a stable API being legitimately broken.
2. **No per-tool versioning infrastructure to leverage.** `MCP_TOOL_VERSION` exists but has never been a living mechanism (static since origin). A formal "tool version bump" (e.g. `query_natural_language_v2` or client-side MCP version negotiation) does not exist in the implemented protocol — introducing it for this single fix would be disproportionate and inconsistent with the rest of the server.
3. **Renaming (`toonReal`/`toonV2`) would also break correct clients.** A client that already ignores `outputFormat==='json'` by default, or that doesn't consume `toon`, is unaffected. A rename breaks *all* clients that read `toon` (including those that, by accident, already handled the future format correctly or ignored it), for a benefit (explicit error instead of silent failure) that doesn't offset a second name-breaking change in a short time on a tool that is still young (introduced and documented in the same release wave, before any confirmed third-party usage).
4. **Limited, mitigable risk surface without renaming.** The TOON format produced by `encodeCompositeAsToon()` includes an identifiable meta line (header+rows+meta) — a client can detect the new format by the presence of this line rather than depending on a field name. Combined with the explicit CHANGELOG entry, the risk of silent failure is mitigated without introducing a second breaking change.
5. **No evidence of external production usage** (no public npm publication, restricted distribution via VS Code extension): the political cost of an "honest" break via renaming has no counterpart in identified real clients to protect.

## Consequences

**Positive**
- A single field name to document across the tool's lifecycle — no API churn for a contract that was never correctly honored.
- Code/documentation alignment: the CHANGELOG stops misrepresenting `query_natural_language`'s behavior.
- `encodeCompositeAsToon()` stays isolated in `src/mcp/tools/query.ts` (or a shared module `src/shared/toon.ts` if reused) — no impact on `analyzer/`, `extension/`, `webview/`.

**Negative**
- Residual risk: an existing external MCP consumer that parses `toon` as JSON today will see a **loud failure for a strict JSON parser** (explicit parse error on `JSON.parse(result.toon)`) but a **transparent change for an LLM relay** (an agent reading `toon` as free text to interpret — the dominant use case for an MCP tool consumed by Copilot/Claude/Cursor — will not see an error, just a different format it needs to reinterpret). The risk is therefore not uniformly "silent": it depends on the consumer type. **Mitigated** by: (a) an explicit "Fixed — Breaking" CHANGELOG entry listing the exact before/after format, (b) a distinctive meta line in the new format enabling programmatic client-side detection, (c) the `MCP_TOOL_VERSION` bump 1.0.0→1.1.0 as a minimal signal (informational only, see Decision note).
- `MCP_TOOL_VERSION` becomes a precedent: since it is bumped here without having been bumped for previous fixes, whether this practice becomes systematic going forward needs deciding (out of scope for this ADR — to be settled separately if it recurs).

**Modified contracts**
- `src/mcp/tools/query.ts`: `QueryNaturalLanguageResult.toon` — name unchanged, content semantics changed (JSON passthrough → real TOON via `encodeCompositeAsToon()`). Input Zod schema (`outputFormat` enum) unchanged.
- `src/mcp/types.ts`: `MCP_TOOL_VERSION` `"1.0.0"` → `"1.1.0"`.
- `docs/architecture/TOON_FORMAT.md` and `CHANGELOG.md`: "Fixed" section documenting the fixed non-conformance + before/after example.
- `shared/query-types.ts` (analyzer, outside external contract): `QueryResult.toon` → `QueryResult.json` — simple rename, no compat to manage (internal only).

## Alternatives rejected

**Option 2 — Rename the field (`toonReal`/`toonV2`)**: rejected. Immediately and systematically breaks all existing clients (including already-tolerant ones), for a marginal gain (explicit error vs. silent failure) when the silent-failure risk is already mitigable via the meta line + CHANGELOG. Introduces a second unstable field name for a tool that is still young, degrading contract readability long-term.

**Option 3 — Formal MCP tool version bump (`query_natural_language_v2` or protocol-level version negotiation)**: dismissed after verification — no per-tool versioning infrastructure exists in this MCP server (`MCP_TOOL_VERSION` is a static information field, never used for routing or compat negotiation). Building this mechanism for a single fix would be out of scope for the story and disproportionate to the identified real risk.

---

Date: 2026-08-28
Author: Antoine (system architect)
Review: Marine (devil's advocate) — PASS, 2 text amendments applied (version bump = informational, not protocol-level; risk = loud for strict JSON parsers / transparent for LLM relays)
