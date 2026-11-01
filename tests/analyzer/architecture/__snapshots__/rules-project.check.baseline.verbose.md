## Architecture check: FAILED

1 new error violation (config graphit.architecture.json, baseline graphit.architecture.baseline.json).

11 files, 1 unmatched; 6 violations (1 new, 5 accepted): 5 errors, 1 warning; 1 resolved.

| Rule | Kind | Severity | Violations | New |
| --- | --- | --- | ---: | ---: |
| `functions-only-shared` | allowOnly | error | 2 | 0 |
| `frontend-not-backend` | forbid | error | 1 | 1 |
| `mfe-isolated` | forbid | warning | 1 | 0 |
| `no-unit-cycles` | noCycles | error | 2 | 0 |

### New violations

#### `frontend-not-backend` (error)

- `frontend/src/app.ts:2` → `backend/src/api.ts`

### Accepted violations

5 violations in the baseline.

#### `functions-only-shared` (error)

Functions are deployed alone; they share code only through libraries.

- `functions/billing/index.ts:2` → `backend/src/db.ts`
- `functions/mail/index.ts:1` → `functions/billing/index.ts`

#### `mfe-isolated` (warning)

- `mfe/cart/src/index.ts:2` → `mfe/checkout/src/index.ts`

#### `no-unit-cycles` (error)

- `shared/ui/src/index.ts:1` → `shared/utils/src/index.ts`
- `shared/utils/src/index.ts:1` → `shared/ui/src/index.ts`

### Resolved violations

In the baseline but no longer found: run --update-baseline to drop them.

- `a.ts` → `b.ts` (`gone`)

### Unmatched files

No element selects them: no rule checks them.

- `scripts/seed.ts`

### Context

- communityMode: path
- revision: <stable>
- graphKind: imports
- scope: workspace
- exclusions: node_modules, .git, dist, build, out, coverage, .next, .nuxt, __pycache__, .venv, venv, target, .*/, .gitignore, .graphitignore, tests/fixtures/, out-*/
- truncated: false
- failedFiles: 0
- baseline: true
