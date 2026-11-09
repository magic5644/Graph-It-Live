# Project Tour report template

Read on demand from the `onboarding-express` skill when writing the report.

Synthesize steps 3–6 into this structured report:

---

### Project Tour — `<ProjectName>`

**3 Main Entry Points**

| # | File | Role | Type |
|---|------|------|------|
| 1 | `src/index.ts` | Application bootstrap, wires all modules | True entry (no callers) |
| 2 | `src/api/router.ts` | HTTP routing, dispatches to controllers | Called by index.ts |
| 3 | `src/cli.ts` | CLI interface, alternative entry point | True entry (no callers) |

**Business Logic Core**

| File | Exported Symbols | Referenced By |
|------|-----------------|---------------|
| `src/services/orderService.ts` | 12 | 8 files |
| `src/domain/pricing.ts` | 7 | 5 files |

**Most Complex Module**

> `src/services/orderService.ts` — 4 levels of internal call depth, 2 internal cycles, imported by 8 files.
> **Recommendation**: Any change here has high blast radius. Run `get_impact_analysis` before modifying.

**Critical Path (Mermaid)**

```mermaid
<trace output here>
```
