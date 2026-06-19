---
# Onboarding AIDD — Graph-It-Live
Date : 2026-06-18

## Scores santé
- Architecture (Antoine) : 7.5/10
- Webview (Clara) : 7.5/10
- Tests (Hugo) : PASS conditionnel

## Violations actives (a corriger avant toute feature)
| Priorite | Fichier | Regle | Description |
|----------|---------|-------|-------------|
| HAUTE | src/webview/utils/graphUtils.ts:92,94,95,136,164-167,194 | Regle 03 | Set/Map crees sans normalizePath() — faux-negatifs lookup Windows/mixed-path |
| HAUTE | src/shared/messages.ts:199,204 | Regle routing | LayoutChangeMessage + ShowSymbolListMessage utilisent `type` au lieu de `command` comme discriminant WebviewMessageRouter |
| HAUTE | vitest.config.mts | Regle 06 | 0 seuil coverage configure — enforcement absent |
| MOYENNE | src/analyzer/ast/AstWorker.ts:71 + AstWorkerHost.ts:26 | Coherence types | WorkerRequest/WorkerResponse dupliques sans source de verite unique |
| MOYENNE | mcp/shared/state.ts | Couplage | WorkerState couple directement a Spider sans interface d'abstraction |
| BASSE | WASM Worker Thread (Electron) | Manque ADR | LinkError connu sans ADR ni fallback formalise |

## Modules sans couverture de test (backlog ordonne)
1. Spider sub-modules (7) : SpiderCacheCoordinator, SpiderGraphCrawler, SpiderIndexingCancellation, SpiderIndexingService, SpiderReferenceLookup, SpiderSymbolService, SpiderWorkerManager
2. mcpServer.ts — 0 test direct
3. useGraphData.ts + symbolUtils.ts — 0 test
4. ReplInkApp.ts — 0 test

## Dette technique (backlog ordonne)
1. Ajouter normalizePath() sur tous les Set/Map de graphUtils.ts (graphUtils.ts:92,94,95,136,164-167,194)
2. Unifier le discriminant des messages Webview vers `command` (messages.ts:199,204)
3. Configurer seuils coverage dans vitest.config.mts (>= 80%)
4. Extraire source de verite unique pour WorkerRequest/WorkerResponse
5. Introduire interface d'abstraction entre WorkerState et Spider
6. Ecrire tests unitaires pour les 7 sous-modules Spider + mcpServer.ts + hooks manquants
7. Stabiliser la reference expandedNodes (Set) dans useMemo deps de useGraphData

## ADRs a produire (urgence decroissante)
1. ADR-001 : Strategie WASM Worker Thread en contexte Electron — LinkError + fallback
2. ADR-002 : Convention discriminant messages Webview (`command` vs `type`)
3. ADR-003 : Source de verite unique pour types Worker (WorkerRequest/WorkerResponse)
4. ADR-004 : Politique normalisation chemins (normalizePath) dans le webview
5. ADR-005 : Seuils coverage et strategie de test par package

## Recommandation sprint 0
/clarify — Les violations actives (routing messages, normalizePath, coverage) revelent des ambiguites de contrat entre couches (Webview <-> Extension, Worker <-> Spider). Avant tout brainstorming feature, il faut clarifier les invariants de ces interfaces pour eviter que les corrections divergent et creent de nouvelles regressions.
---
