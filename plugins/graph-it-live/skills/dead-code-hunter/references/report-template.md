# Dead Code Scan Report template

Read on demand from the `dead-code-hunter` skill when writing the deletion plan.

Produce a **Deletion Plan** in this format:

---

### Dead Code Scan Report

**Scanned**: `<N>` files | **Candidates found**: `<M>` symbols + `<K>` ghost files

#### Possible Ghost Files (confirmation required)

| File | Last modified | Reason |
|------|--------------|--------|
| `src/utils/oldMigration.ts` | 2022-03-11 | No incoming file references confirmed; entry-point and external-use checks completed |

#### Symbol Candidates — Manual Review

| Symbol | File | Kind | Reference evidence |
|--------|------|------|---------|
| `formatLegacyCurrency` | `src/utils/format.ts` | function | Include incoming-reference and type-only check status |
| `MD5Hash` | `src/services/auth.ts` | function | Include incoming-reference and type-only check status |

#### Orphan Symbols — Review First

| Symbol | File | Risk | Note |
|--------|------|------|------|
| `createReport` | `src/api/index.ts` | Barrel export | Check if consumed by external packages |

#### Test-Only Symbols

| Symbol | File | Test callers |
|--------|------|-------------|
| `mockPaymentGateway` | `src/mocks/payment.ts` | 3 test files |

---

### Recommended Deletion Order

1. Complete missing incoming-reference checks; keep unconfirmed candidates out of deletion recommendations
2. Review possible ghost files, public APIs, barrel exports, and external consumers
3. Review remaining symbol candidates and test-only use with the team
