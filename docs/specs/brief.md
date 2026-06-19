# Brief — Sprint 0 + Sprint 1 + Sprint Coverage
Date : 2026-06-18
Statut : Sprint 0 COMPLÉTÉ — Sprint Coverage à planifier

## Sprint 0 — Dette technique (priorité immédiate)

### Objectif
Corriger les 3 violations HAUTE identifiées en onboarding + enforcer le seuil de coverage.

### Périmètre

#### Correction 1 — normalizePath dans graphUtils.ts (Règle 03)
- Fichier : `src/webview/utils/graphUtils.ts`
- Lignes : 92, 94, 95, 136, 164-167, 194
- Fix : ajouter `normalizePath()` avant tout `Set.add()` / `Map.set()` sur des chemins de fichier
- Owner : Emma (webview developer)
- Risque : faux-négatifs de lookup sur Windows/mixed-path → silent bug

#### ~~Correction 2 — Discriminant messages.ts~~ FERMÉ (false positive)
- Fichier : `src/shared/messages.ts:199,204`
- Investigation : `App.tsx:583,587` utilise intentionnellement `'type' in message` guard pour ces deux messages.
  `WebviewMessageRouter` gère la direction inverse (webview→extension), pas concerné.
- Verdict : pattern intentionnel, pas de bug fonctionnel. Aucune modification nécessaire.

#### Correction 3 — WorkerRequest/Response dupliqués (Règle 05)
- Fichiers : `src/analyzer/ast/AstWorker.ts:71` + `src/analyzer/ast/AstWorkerHost.ts:26`
- Fix : extraire source de vérité unique dans `src/analyzer/ast/AstWorkerProtocol.ts` (ou `src/shared/`)
- Owner : Lucas (analyzer developer)
- Risque : désynchronisation silencieuse lors d'une modification unilatérale

#### Correction 4 — Seuil coverage vitest.config.mts (Règle 06)
- Fichier : `vitest.config.mts`
- Fix : ajouter `thresholds: { lines: 80, functions: 80 }` dans coverage config
- Owner : Hugo (QA) / Alex (DevOps)
- Note : enforcer AVANT d'atteindre 80% → CI bloquera si gap trop grand. Vérifier coverage actuelle d'abord.

### Hors-périmètre Sprint 0
- Nouvelles features
- Refacto WASM Worker Thread (ADR-003 d'abord)
- Spider sub-modules tests (sprint 1+)
- ADRs formels (sprint 1 ou parallèle)

---

## Sprint Coverage — Atteindre 80% (priorité avant toute feature)

### État actuel (2026-06-18)
| Métrique | Actuel | Seuil bloquant |
|----------|--------|----------------|
| Lines | 58.81% | 80% |
| Functions | 63.56% | 80% |
| Statements | 57.89% | — |
| Branches | 48.04% | — |

### Stratégie : 80% dur maintenu — sprint dédié couverture

Le seuil 80% dans `vitest.config.mts` bloque `npm run test:coverage` jusqu'à atteinte.
CI devra contourner jusqu'à resolution (utiliser `npm run test:unit` en attendant).

### Fichiers prioritaires (0% → impact maximal)
| Fichier | Lignes | Type de test requis |
|---------|--------|---------------------|
| `mcpServer.ts` | 1879 | Tests intégration MCP |
| `GraphViewService.ts` | ~900 | E2E VS Code |
| `useGraphData.ts` | 441 | Vitest + jsdom webview |
| `AstWorker.ts` | 235 | Worker thread mock |
| `extension.ts` | 154 | E2E VS Code |
| `ReplInkApp.ts` | ~1458 | CLI integration tests |

### Owner : Hugo (coordination) + tous les devs de layer
### Prérequis : aucun — peut démarrer en parallèle de Sprint 1

---

## Sprint 1 — Bug #106 (après Sprint 0)

### Objectif
Résoudre le bug reverse index désactivé en mode standalone `graph-it serve`.

### Description
En mode MCP standalone (`graph-it serve`), `reverseIndexEnabled` reste `false`.
Aucun flag CLI, env var, ni paramètre MCP ne permet de l'activer.
8 tools retournent des résultats vides sans erreur : `find_referencing_files`, `get_symbol_callers`,
`get_symbol_dependents`, `get_impact_analysis`, `find_unused_symbols`, `scan_dead_code`,
`verify_dependency_usage`, `analyze_breaking_changes`.

### Solution proposée (à valider par Antoine)
Options :
- A) Env var `ENABLE_REVERSE_INDEX=true` (cohérent avec `WORKSPACE_ROOT`, `EXCLUDE_NODE_MODULES`)
- B) Flag CLI `--reverse-index` dans `graph-it serve`
- C) Activer par défaut en mode serve (breaking change si comportement existant)

### Owner : Marco (MCP) + Lucas (analyzer config)

---

## Acteurs
- Développeurs utilisant Graph-It-Live en extension VS Code
- Utilisateurs MCP standalone (`graph-it serve`) — signalé par issue #106
- LLM clients (Copilot, Claude, Cursor) consommant les 22 tools MCP

## Contraintes techniques
- NO vscode imports dans analyzer/mcp (Règle 01)
- Bundles séparés : webview.js + callgraph.js (Règle 05)
- Tests : unit mock WASM, E2E WASM réel (Règle 06)
- Cross-platform : normalizePath obligatoire (Règle 03)
