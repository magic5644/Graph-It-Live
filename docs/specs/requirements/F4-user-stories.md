# F4 — Community Detection (Louvain) : User Stories

**Feature** : Détection de communautés sur le graphe de fichiers (Louvain).
**Auteur** : Julie (analyste requirements)
**Date** : 2026-06-29
**Dépendances feature** : F2 (NodeMetadataBuilder, `hubScore`, `fileExtension` — source of truth)

---

## Dépendances entre stories

```
US-F4-01  ←  US-F4-02  ←  US-F4-03 (visual)
                       ←  US-F4-04 (CLI/MCP)
US-F4-02  ←  US-F4-03 (enrichissement NodeMetadataBuilder)
US-F4-06  (dégradation gracieuse — transversale)
```

- US-F4-01 est le noyau algorithmique. Toutes les autres en dépendent.
- US-F4-02 enrichit `GraphNodeMetadata` — prérequis pour US-F4-03 et US-F4-04.
- US-F4-03 intègre `detectCommunities` dans `NodeMetadataBuilder` — dépend de US-F4-02 (pas US-F4-05).
- US-F4-04 ne peut démarrer qu'après US-F4-03 (communityId présent dans nodeMetadata).
- US-F4-05 ne peut démarrer qu'après US-F4-03 (communityId présent dans nodeMetadata).
- US-F4-06 peut s'implémenter en parallèle de US-F4-04 et US-F4-05.

---

## Ambiguïtés identifiées (à clarifier avant GATE-5)

1. **Granularité des communautés** : combien de communautés attendre sur un projet réel de ~500 fichiers ? Y a-t-il un seuil min/max à exposer en config VS Code ?
2. **Stabilité des IDs** : `communityId` est un entier arbitraire (0, 1, 2…). Entre deux runs, l'ID 0 peut changer de signification. Est-ce acceptable pour l'UX (couleurs qui changent) ? Faut-il un mécanisme de stabilisation (tri par taille, ancrage sur un fichier racine) ?
3. **Graphe orienté vs non-orienté** : Louvain opère sur un graphe non-orienté. Les `GraphEdge` sont orientées. La symétrie automatique (A→B + B→A) doit être confirmée comme approche par défaut.
4. **Seuil de résolution Louvain** : le paramètre `gamma` (résolution) est-il fixe ou configurable ? Valeur par défaut recommandée : 1.0.
5. **Dépendance externe** : confirmer que `graphology-communities-louvain` est acceptable si l'algo interne dépasse ~150 lignes maintenables.

---

## User Stories

---

**US-F4-01 : Calcul Louvain dans l'analyzer**
En tant que développeur Graph-It-Live, je veux un module `src/analyzer/CommunityDetector.ts` qui applique l'algorithme Louvain sur les nodes et edges d'un `GraphData` afin de produire un mapping `filePath → communityId` sans dépendance VS Code.

Score de clarté : **8/10**

Critères d'acceptation :

- [ ] CA1 : `detectCommunities(graphData: GraphData, options?: { seed?: number }): Map<string, number>` est exporté depuis `src/analyzer/CommunityDetector.ts`. Retourne un `Map<normalizedPath, communityId>`.
- [ ] CA2 : Sur un graphe de 4 nodes (A→B, A→C, D→E) sans connexion entre groupes {A,B,C} et {D,E}, la fonction appelée avec `{ seed: 42 }` retourne au minimum 2 communityIds distincts. Les tests utilisent systématiquement ce seed pour garantir un résultat déterministe.
- [ ] CA3 : Sur un graphe vide (`nodes: [], edges: []`), retourne un `Map` vide sans exception.
- [ ] CA4 : Sur un graphe sans edges, chaque node peut être sa propre communauté — aucune exception n'est levée.
- [ ] CA5 : Toutes les clés du `Map` retourné sont le résultat de `normalizePath(filePath)` (Règle 03).
- [ ] CA6 : `grep -r "from 'vscode'" src/analyzer/CommunityDetector.ts` retourne vide (Règle 01).
- [ ] CA7 : Les `GraphEdge` orientées sont traitées comme non-orientées (symétrie automatique : A→B implique B→A dans le calcul modularity).
- [ ] CA8 : Le module est couvert à ≥ 80% par `tests/analyzer/CommunityDetector.test.ts` (Règle 06).
- [ ] CA9 : Si une dépendance npm externe est ajoutée pour l'algorithme Louvain, elle figure dans `package.json` et `npm audit` ne signale aucune vulnérabilité de sévérité haute ou critique au moment du merge.

---

**US-F4-02 : Enrichissement de `GraphNodeMetadata` avec `communityId`**
En tant que développeur consommant `GraphData`, je veux que `GraphNodeMetadata` expose un champ `communityId?: number` afin de pouvoir identifier la communauté d'appartenance de chaque fichier sans modifier la structure `nodes: string[]`.

Score de clarté : **9/10**

Critères d'acceptation :

- [ ] CA1 : `GraphNodeMetadata` dans `src/shared/graph-types.ts` contient `communityId?: number` avec un JSDoc précisant "Absent means community detection was not run — consumers MUST NOT use ?? 0".
- [ ] CA2 : Les types existants (`hubScore`, `loc`, `fileExtension`) sont inchangés — zéro breaking change sur les interfaces publiques.
- [ ] CA3 : `communityId: 0` est un identifiant valide (la communauté numéro 0 existe). `communityId` absent signifie "non calculé".
- [ ] CA4 : Un test Vitest dans `tests/shared/graph-types.test.ts` vérifie qu'un objet `{ hubScore: 0 }` sans champ `communityId` est accepté sans erreur par le schéma Zod de `src/mcp/types.ts` (parse runtime, pas vérification TypeScript statique).
- [ ] CA5 : `npm run check:types` passe sans erreur après ajout du champ.

---

**US-F4-03 : Intégration dans `NodeMetadataBuilder` (F2 enrichissement)**
En tant que développeur layer analyzer, je veux que `computeNodeMetadata` dans `NodeMetadataBuilder.ts` appelle `detectCommunities` et peuple `communityId` sur chaque entrée `nodeMetadata` afin que la communauté soit disponible dans `GraphData` sans passe supplémentaire.

Score de clarté : **7/10** (ambiguïté n°3 : ordre d'appel et conditionnalité)

Critères d'acceptation :

- [ ] CA1 : Après appel à `computeNodeMetadata(graphData)`, si le graphe contient au moins 1 edge, chaque entrée de `graphData.nodeMetadata` possède un `communityId` défini (nombre entier ≥ 0). Les nodes présents dans `nodes[]` mais sans aucune edge entrante ni sortante (nodes isolés) reçoivent un `communityId` distinct qui leur est propre — ils ne sont pas exclus du résultat. Ce comportement est documenté dans le JSDoc de `computeNodeMetadata`.
- [ ] CA2 : Si le graphe ne contient aucune edge (toutes les entrées de `edges[]` sont absentes), `communityId` est absent de toutes les entrées (pas de communauté calculée sur graphe isolé — comportement explicitement documenté dans le JSDoc).
- [ ] CA3 : `computeNodeMetadata` continue de produire `hubScore` et `fileExtension` avec les mêmes valeurs qu'avant l'ajout (non-régression F2).
- [ ] CA4 : `tests/analyzer/NodeMetadataBuilder.test.ts` couvre le cas "graphe avec edges → communityId présent", "graphe sans edges → communityId absent", et "graphe avec node isolé (présent dans nodes[] mais sans edge) → communityId distinct attribué".
- [ ] CA5 : Couverture du fichier `NodeMetadataBuilder.ts` reste ≥ 80% après modification (Règle 06).

Dépendances : US-F4-03 → US-F4-02 (pas US-F4-05).

---

**US-F4-04 : Couleur par communauté dans la vue ReactFlow**
En tant qu'utilisateur final de l'extension VS Code consultant le graphe de fichiers, je veux que les nodes ReactFlow d'une même communauté partagent une couleur de fond distincte afin de visualiser immédiatement les clusters thématiques de mon projet.

Score de clarté : **6/10** (ambiguïté n°2 : stabilité des couleurs entre runs)

Critères d'acceptation :

- [ ] CA1 : Dans `src/webview/components/reactflow/buildGraph.ts`, si un node possède `communityId` dans `nodeMetadata`, sa couleur de fond est dérivée de `communityId` via une palette prédéfinie (minimum 10 couleurs distinctes).
- [ ] CA2 : Deux nodes avec le même `communityId` reçoivent exactement la même couleur de fond.
- [ ] CA3 : Un node sans `communityId` dans `nodeMetadata` conserve la couleur de fond par défaut actuelle (aucune régression visuelle).
- [ ] CA4 : Chaque couleur de la palette satisfait un ratio de contraste WCAG AA ≥ 4.5:1 sur fond blanc (#FFFFFF) et ≥ 3:1 sur fond sombre (#1E1E1E — thème VS Code Dark+), vérifiable via un outil automatique (ex. `jest-axe`, `color-contrast-checker`, ou calcul programmatique intégré dans les tests).
- [ ] CA5 : `tests/webview/components/reactflow/buildGraph.test.ts` couvre : node avec `communityId: 0`, node avec `communityId: 5`, node sans `communityId` — vérification de la couleur assignée.

---

**US-F4-05 : `communityId` accessible via CLI et MCP**
En tant que client LLM (Copilot, Claude, Cursor) ou script CLI, je veux que les outils MCP et commandes CLI retournant `nodeMetadata` exposent `communityId` afin de pouvoir grouper ou filtrer les fichiers par communauté dans mes analyses automatisées.

Score de clarté : **8/10**

Critères d'acceptation :

- [ ] CA1 : La commande `graph-it architecture --format json` retourne, pour chaque node ayant une communauté détectée, un champ `communityId` dans son objet `nodeMetadata`. La détection de communautés est activée par défaut dans cette commande (opt-out via flag `--no-community` si implémenté — à préciser par Marco). Si aucun flag n'est défini, le comportement par défaut (opt-in ou opt-out) doit être documenté dans `docs/CLI.md`.
- [ ] CA2 : Les tools MCP suivants incluent `communityId` dans le payload JSON retourné : `generate_codemap` [à préciser par Marco — liste exacte des tools MCP exposant `nodeMetadata` à confirmer avant GATE-5]. L'ajout est non-brisant (champ optionnel dans le schéma Zod existant).
- [ ] CA3 : Le schéma Zod correspondant dans `src/mcp/types.ts` déclare `communityId: z.number().int().min(0).optional()`.
- [ ] CA4 : `tests/mcp/types.test.ts` vérifie que le parsing Zod accepte un payload avec `communityId` et un payload sans `communityId` (champ optionnel).
- [ ] CA5 : `grep -r "from 'vscode'" src/mcp/` retourne vide après modification (Règle 01).
- [ ] CA6 : La doc CLI (`docs/CLI.md`) mentionne `communityId` dans la description du champ `nodeMetadata`.

---

**US-F4-06 : Dégradation gracieuse si détection échoue**
En tant que développeur utilisant Graph-It-Live sur un graphe très large ou atypique, je veux que l'échec de la détection de communautés n'interrompe pas l'affichage du graphe afin que la visualisation reste disponible même si le clustering est indisponible.

Score de clarté : **9/10**

Critères d'acceptation :

- [ ] CA1 : Si `detectCommunities` lève une exception, `computeNodeMetadata` capture l'erreur, log un warning (pas une erreur fatale), et après capture de l'exception, aucune entrée de `graphData.nodeMetadata` ne contient de champ `communityId` (la fonction est de type `void` sur ce point — elle mutate `graphData` sans retourner de valeur de contrôle).
- [ ] CA2 : La vue ReactFlow s'affiche sans erreur JS quand `communityId` est absent de tous les nodes (cas : detection désactivée ou échouée).
- [ ] CA3 : Un test unitaire simule `detectCommunities` qui throw — vérifie que `computeNodeMetadata` ne propage pas l'exception et que `communityId` est absent du résultat.
- [ ] CA4 : Le message de warning loggé contient le mot "community" et la cause de l'erreur pour faciliter le diagnostic.

---

## Résumé des personas impliqués

| Persona | Stories concernées |
|---|---|
| Utilisateur final de l'extension VS Code | US-F4-04 |
| Développeur intégrant Graph-It-Live dans un script | US-F4-05 (CLI) |
| Client LLM via MCP (Copilot, Claude, Cursor) | US-F4-05 (MCP) |
| Développeur Graph-It-Live (mainteneur) | US-F4-01, US-F4-02, US-F4-03, US-F4-06 |
