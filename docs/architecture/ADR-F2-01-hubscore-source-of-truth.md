# ADR-F2-01 : Source de vérité hubScore

## Status

Proposed

## Context

Story F2 ajoute `nodeMetadata?: Record<string, GraphNodeMetadata>` à `GraphData` (src/shared/graph-types.ts).
`GraphNodeMetadata` inclut `hubScore: number`.

`parentCounts?: Record<string, number>` existe déjà dans `GraphData` et est transmis au webview.
F1 (mergée) a implémenté `computeHubScores(visibleNodes, parentCounts)` dans `src/webview/components/reactflow/buildGraph.ts` — normalise sur les noeuds visibles uniquement.
`src/analyzer/wiki/WikiGenerator.ts` calcule déjà un `hubScore` workspace-wide pour les articles wiki.

Consommateurs qui ont besoin d'un hubScore stable : MCP (`graphitlive_analyze_dependencies` retourne `GraphData` sérialisé), CLI, export HTML F3, community detection F4 (Louvain).

## Decision

**Option A retenue : Spider (analyzer layer) est la seule source de vérité pour `hubScore`.**

Spider calcule `hubScore = parentCounts[file] / max(parentCounts)` normalisé [0-1] sur le workspace entier, lors du full-crawl uniquement (pas de mise à jour incrémentale partielle pour éviter un `maxParentCount` sous-estimé). Le résultat est stocké dans `nodeMetadata` de `GraphData`.

`computeHubScores` de F1 est remplacé par une lecture directe de `nodeMetadata[path].hubScore` dans `buildGraph.ts`.

Le calcul `hubScore` de `WikiGenerator.ts` est unifié : WikiGenerator lit `nodeMetadata.hubScore` depuis `GraphData` au lieu de recalculer.

## Consequences

**Positives**
- Source unique : un seul endroit à maintenir, cohérence garantie entre MCP, CLI, export HTML (F3) et webview.
- F3 (export HTML) et F4 (Louvain) lisent `nodeMetadata` sans recalcul.
- Conforme Règle 01 : pur Node.js dans l'analyzer, zéro import vscode.
- Suppression de duplication : calcul Wiki absorbé, `computeHubScores` webview supprimé.

**Negatives**
- Hub local dans un sous-graphe filtré peut afficher un score faible (exemple : noeud central d'un sous-graphe de 10 fichiers sur un workspace de 1000). Accepté : la vue webview gagne en cohérence avec MCP et CLI au détriment de la relativité locale.
- `nodeMetadata` doit etre versionné avant F4 : si Louvain modifie la sémantique de `hubScore`, un champ `hubScoreVersion?: string` ou une migration breaking sera nécessaire.

**Contrats modifiés**
- `src/shared/graph-types.ts` : ajout `GraphNodeMetadata` + `nodeMetadata?` sur `GraphData`.
- `src/analyzer/Spider.ts` (ou `GraphCrawler`) : calcul `hubScore` sur full-crawl, guard `max === 0 → score = 0`.
- `src/analyzer/wiki/WikiGenerator.ts` : lecture `nodeMetadata.hubScore` au lieu du calcul interne.
- `src/webview/components/reactflow/buildGraph.ts` : suppression `computeHubScores`, lecture `nodeMetadata[path]?.hubScore ?? 0`.
- `src/mcp/` : Zod schema `graphitlive_analyze_dependencies` étendu avec `nodeMetadata` optionnel.

## Alternatives rejetées

**Option B — buildGraph.ts (webview) uniquement** : score instable (change à chaque filtre de vue), absent de MCP et CLI. `parentCounts` brut transmis au webview ne suffit pas : MCP consomme `GraphData` sérialisé sans passer par le webview, et F3/F4 opèrent hors bundle webview.

**Option C — Double calcul (global + local)** : rejetée sur recommandation de Marine. Deux sources sans règle de priorité formelle = comportement indéfini selon le chemin d'exécution (webview vs MCP vs export). Duplication de logique de normalisation dans deux bundles séparés (`dist/extension.js` et `dist/webview.js`) : toute évolution de formule (F4 Louvain) doit être propagée manuellement — risque de régression silencieux.

---

Date : 2026-06-27
Auteur : Antoine (architecte système)
Review : Marine (devil's advocate)
