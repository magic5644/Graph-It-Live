## Architecture check: FAILED

5 new error violations (config graphit.architecture.json, no baseline).

11 files, 1 unmatched; 6 violations (6 new, 0 accepted): 5 errors, 1 warning; 0 resolved.

| Rule | Kind | Severity | Violations | New |
| --- | --- | --- | ---: | ---: |
| `functions-only-shared` | allowOnly | error | 2 | 2 |
| `frontend-not-backend` | forbid | error | 1 | 1 |
| `mfe-isolated` | forbid | warning | 1 | 1 |
| `no-unit-cycles` | noCycles | error | 2 | 2 |

### New violations

#### `functions-only-shared` (error)

Functions are deployed alone; they share code only through libraries.

- `functions/billing/index.ts:2` → `backend/src/db.ts`
- `functions/mail/index.ts:1` → `functions/billing/index.ts`

#### `frontend-not-backend` (error)

- `frontend/src/app.ts:2` → `backend/src/api.ts`

#### `mfe-isolated` (warning)

- `mfe/cart/src/index.ts:2` → `mfe/checkout/src/index.ts`

#### `no-unit-cycles` (error)

- `shared/ui/src/index.ts:1` → `shared/utils/src/index.ts`
- `shared/utils/src/index.ts:1` → `shared/ui/src/index.ts`

### Unmatched files

No element selects them: no rule checks them.

- `scripts/seed.ts`
