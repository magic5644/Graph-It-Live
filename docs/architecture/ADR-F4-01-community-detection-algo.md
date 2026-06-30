# ADR-F4-01 : Algorithme de community detection (Louvain)

## Status

Proposed

## Context

Story F4 ajoute la community detection au graphe de dépendances (50-500 noeuds, arêtes dirigées import → dépendance). Le résultat alimente le colour-coding des noeuds dans le webview ReactFlow, les exports HTML (F3), et les outils MCP. L'algo doit opérer dans `src/analyzer/` (Règle 01 : pur Node.js, NO vscode imports). Le bundle CLI `dist/graph-it.js` pèse actuellement 10.4 MB (WASM sql.js inclus) — toute dépendance npm s'additionne à ce poids via esbuild CJS.

## Decision

**Option A retenue : implémentation maison Louvain phase-1 uniquement (~150 lignes TypeScript, zéro dépendance npm).**

Justification par critère :

1. **Qualité algorithmique à l'échelle cible.** Louvain phase-1 (optimisation locale de la modularité) converge vers une partition de qualité acceptable sur des graphes < 500 noeuds. La phase-2 (agrégation hiérarchique) apporte un gain marginal à cette échelle — elle devient utile au-delà de ~5 000 noeuds selon la littérature. Les graphes de dépendances TypeScript typiques de Graph-It-Live restent en dessous de ce seuil.

2. **Impact bundle CLI.** `graphology` dépaqueté = 2.73 MB ; après tree-shaking esbuild le résidu reste estimé à 300-500 KB (graphology expose de nombreux modules non-tree-shakable en CJS). Sur un bundle de 10.4 MB, l'ajout de 400 KB est acceptable en absolu, mais introduit quatre dépendances transitives (`graphology-indices`, `graphology-utils`, `mnemonist`, `pandemonium`) dont la compatibilité CJS/ESM avec esbuild n'est pas vérifiée — risque de conflit de build non justifié pour un gain de qualité nul à < 500 noeuds.

3. **Déterminisme.** L'implémentation maison utilise un Fisher-Yates shuffle avec seed fixe, garantissant une partition reproductible entre runs. `graphology-communities-louvain` propose `randomWalk: false` mais ne documente pas de seed externe — le déterminisme est un contrat nécessaire pour la stabilité des exports HTML et des réponses MCP.

4. **Arêtes dirigées.** Louvain maison traite les arêtes dirigées comme non-dirigées (somme in+out pour le calcul de modularité), cohérent avec la sémantique de couplage structurel entre fichiers. graphology-communities-louvain supporte nativement le mode `directed` mais sa modularité dirigée produit des communautés plus fragmentées sur des DAGs d'import — comportement moins lisible pour l'utilisateur final.

5. **Maintenance.** 150 lignes TypeScript internes, sans surface d'API tierce à maintenir. Aucune montée de version à tracker.

## Consequences

**Positives**
- Zéro ajout au bundle CLI et .vsix — Règle 02 inchangée, pas de .map supplémentaire.
- Déterminisme garanti par seed explicite (Fisher-Yates) : exports HTML et réponses MCP stables entre runs.
- Aucune dépendance transitive (graphology-indices, mnemonist, pandemonium) à auditer pour Règle 01 et compatibilité esbuild CJS.
- Implémentation localisée dans `src/analyzer/callgraph/` ou `src/analyzer/communityDetection.ts` — testable unitairement sans mock npm.

**Negatives**
- Phase-2 absente : sur des workspaces exceptionnellement denses (> 500 noeuds, graphes monorepo), la qualité de partition peut être inférieure à graphology. Accepté : hors du profil cible actuel.
- Code métier à maintenir en interne. Si l'algorithme évolue (Leiden, SBM), la migration sera manuelle. Mitigé : l'interface de sortie (`Map<string, number>` fileId → communityId) est stable et remplaçable sans impact sur les couches supérieures.
- Risque d'implémentation incorrecte du calcul de modularité (delta Q). Mitigé : tests unitaires obligatoires sur graphes de référence avec partition connue (triangle, bipartite, chaîne).

**Contrats modifiés**
- `src/shared/graph-types.ts` : ajout `communityId?: number` dans `GraphNodeMetadata` (déjà prévu par ADR-F2-01).
- `src/analyzer/communityDetection.ts` (nouveau fichier) : export `detectCommunities(nodes: string[], edges: [string, string][]): Map<string, number>` — pur Node.js, NO vscode.
- `src/analyzer/Spider.ts` (ou `GraphCrawler`) : appel `detectCommunities` après full-crawl, résultat écrit dans `nodeMetadata[path].communityId`.
- `src/webview/components/reactflow/buildGraph.ts` : lecture `nodeMetadata[path]?.communityId` pour la couleur de noeud.
- `src/mcp/types.ts` : Zod schema `nodeMetadata` étendu avec `communityId?: number`.

## Alternatives rejetées

**Option B — `graphology-communities-louvain` v2.0.2 + `graphology` v0.26.0** : rejetée. Gain de qualité nul à < 500 noeuds. Ajout estimé 300-500 KB au bundle CJS post-esbuild. Quatre dépendances transitives dont la compatibilité CJS/ESM avec esbuild bundler n'est pas vérifiée (risque de build cassé). Déterminisme par seed externe non documenté. Rapport coût/bénéfice défavorable au profil cible.

**Option C — Algorithme de Leiden (état de l'art post-Louvain)** : rejetée. Aucune implémentation TypeScript mature disponible sans dépendances lourdes. Complexité d'implémentation maison élevée (correction des coupures arbitraires de Louvain). Hors scope F4.

**Option D — Label Propagation (LPA)** : rejetée. Convergence non garantie, résultat non déterministe sans mécanisme de tie-breaking complexe. Qualité inférieure à Louvain sur graphes structurés en modules denses.

---

Date : 2026-06-29
Auteur : Antoine (architecte système)
Review : Marine (devil's advocate) — à compléter avant GATE-5
