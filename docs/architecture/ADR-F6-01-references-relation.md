# ADR-F6-01: `REFERENCES` relation for runtime references that are not calls

## Status

Accepted (#575, part 2 of #567)

## Context

The call graph has four relations: `CALLS`, `INHERITS`, `IMPLEMENTS` and
`USES`. Every surface treats `USES` as a type-only reference:

- `query_call_graph` hides it unless `includeTypeOnly` is set;
- the native LM callers tool reports a `USES` caller as type-only;
- cycle detection in `CallGraphIndexer` and `CallGraphQuery` ignores it;
- the call-graph webview styles it as a type edge.

#574 recorded JSX components (`<Card />`) as `USES`, so a render was hidden by
default and reported as type-only. React also passes functions without calling
them (`onClick={save}`, `render={Row}`). Such a reference is runtime evidence,
but it is not an invocation at that line, so it must not be a `CALLS` edge and
must not appear as a call in callers results.

The ts-morph pipeline (`SymbolAnalyzer`, used by trace, symbol dependents and
impact) has no relation at all: every use of an import is one dependency,
reported as a call by `trace`.

## Decision

Add a fifth relation, `REFERENCES`: a runtime reference to a symbol that is
not invoked where it appears. It covers:

- a JSX component element (`.jsx`/`.tsx`): `<Card />`, `<Card>…</Card>`,
  `<UI.Card />`;
- a JSX attribute whose value is a bare identifier or member expression:
  `onClick={save}`, `render={Row}`, `as={UI.Link}`, and any other value that
  names a symbol (`value={DEFAULTS}`);
- a function passed as an argument, in every call graph language:
  `register(save)`, `items.map(format)`, `new Worker(run)` (TS/JS),
  `register(cb=save)` (Python), `register(helper::save)` (Rust),
  `register(pkg.Save)` (Go), `Register(Save)` (C#), `register(this::save)`
  (Java method reference);
- `lazy(() => import('./literal'))`: the default export it loads.

A call written inside such a value (`onClick={() => save()}`,
`register(save())`) stays a `CALLS` edge at its own line. Intrinsic elements
(`<div />`), namespaced names (`<svg:rect />`) and fragments create no edge.

A reference links only when its target is proven: an import binding, the
innermost declaration of its name in scope (a parameter or a local variable of
that name links nowhere), a member of `this`/`self`/`Self`, or the only
same-file declaration of its name. A member of any other object
(`props.save`, `<Ext.Card />`), a name declared nowhere, a non-literal or
unknown wrapper, and a name two `export *` modules both declare stay
unresolved; no homonym is guessed.

Contract changes, made together:

- `RelationType` in `src/shared/callgraph-types.ts`, the SQLite `CHECK`
  constraint and call-graph schema version v13 (older indexes rebuild);
- the `relationTypes` Zod enum; the `query_call_graph` default filter becomes
  `CALLS`, `INHERITS`, `IMPLEMENTS`, `REFERENCES`; `includeTypeOnly` still adds
  only `USES`;
- cycle detection counts `REFERENCES` (a component rendering itself through
  another component is a real runtime cycle);
- graph-context relation list and scoring, the call-graph webview style and
  legend;
- `SymbolDependency.relation?: "REFERENCES"` in the ts-morph pipeline: absent
  keeps today's meaning (a call or another use of the symbol). Trace, callers
  and impact results expose the relation so a reference never reads as a call.

Line numbers keep each surface's documented base: call-graph results
(`query_call_graph`, `startLine`, `sourceLine`) are 0-based, symbol results
(trace, dependents, impact) are 1-based. Cross-surface tests compare source
locations after that documented conversion.

## Alternatives rejected

- **Keep `USES` for JSX and handler references** (text of #575): the default
  filter, the type-only flag of LM callers and cycle detection would all stay
  wrong for runtime references, and telling them apart at query time by target
  kind fails for class components used both as a type and as an element.
- **Record references as `CALLS`**: `onClick={save}` does not call `save` at
  that line; callers and trace would claim an invocation that may never happen.
- **Edge flag column on `USES`**: needs the same schema migration as a new
  relation while every filter would have to read two fields.
- **Re-base all lines to 1**: breaks the documented 0-based `startLine`
  selector of `query_call_graph` for existing clients.
