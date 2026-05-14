# Sequence Diagram Generation (CLI + MCP + Plugin) — Design Spec

**Date:** 2026-05-14  
**Statut:** Approuvé (design)  
**Scope:** Phase 1 + trajectoire monorepo

---

## Contexte et objectif

Graph-It-Live expose déjà un call graph puissant (CLI, MCP, panel plugin), mais il manque une vue “séquence d’exécution” exploitable à partir d’un point d’entrée fonctionnel.

Objectif produit validé:

1. **Fidélité maximale** (dans domaine statique résoluble)
2. **Vitesse rapide**, surtout en **gros monorepos**
3. **Lisibilité excellente** en sortie Mermaid/UX panel

Contraintes validées:

- Source d’analyse: **statique Tree-sitter** (pas d’instrumentation runtime en MVP)
- Couverture langage MVP: **TS/JS/Python/Rust/C#/Go/Java**
- Couverture fonctionnelle: **CLI + MCP/tools + nouvelle vue plugin dédiée**
- Inclure en MVP: **intra-projet + externes + annotations** (`async/await`, `return`, `throws` quand détectable)

---

## Approche retenue

Approche retenue: **Hybride cache-first**.

- **Moteur unique on-demand** (source de vérité commune)
- **Cache obligatoire à 2 niveaux** (mémoire + disque workspace)
- Évolution possible vers index séquence plus poussé sans casser API

Pourquoi ce choix:

- Time-to-value plus rapide que architecture “index-only” complète
- Contrat de qualité maintenu (déterminisme, explicitation ambiguïtés)
- Coût monorepo maîtrisé via cache/invalidation incrémentale

---

## Architecture cible

### 1) Moteur central commun

Nouveau composant analyzer:

- `SequenceEngine` (nom logique)

Responsabilités:

- Résoudre flux d’appels depuis `filePath + symbolName`
- Produire modèle canonique `SequenceModel`
- Rendre dérivés `mermaid`, `json`, `markdown`
- Exposer warnings, confidence, truncation

Consommateurs:

- CLI `graph-it sequence ...`
- MCP tool `graphitlive_generate_sequence_diagram`
- Extension service/panel `SequenceViewService` (nouveau panel dédié)

### 2) Pipeline de génération

1. Extraction Tree-sitter locale (captures appels + contexte async/error)
2. Résolution intra-fichier (table symboles locale)
3. Résolution intra-workspace (index/call graph SQL existants quand possible)
4. Résolution externe via stubs nommés
5. Annotation des edges (`confidence`, `unresolved`, `reason`)
6. Assemblage ordonné déterministe (`SequenceModel`)

### 3) Cache monorepo obligatoire

#### L1 mémoire process (LRU)

- Clé: `workspaceRoot + entrySymbol + options + engineVersion + dependencyFingerprint`
- TTL court (5-10 min)
- Taille bornée configurable

#### L2 disque workspace

- Emplacement: `.graph-it/sequence-cache/`
- Métadonnées versionnées:
  - `schemaVersion`
  - `engineVersion`
  - `queryVersion`
- Invalidation incrémentale sur save/delete/rename
- Recompute auto si stale

Comportement attendu:

- Cache hit: réponse quasi instantanée
- Cache miss: compute + persist
- Cache stale: recompute + refresh cache

---

## Contrats API

### CLI

Nouvelle commande:

```bash
graph-it sequence <file#symbol> [options]
```

Options MVP:

- `--maxDepth <n>` (défaut 6)
- `--maxSteps <n>` (défaut 200)
- `--includeExternal` (défaut true)
- `--includeAnnotations` (défaut true)
- `--no-cache`
- `--format text|json|toon|markdown|mermaid`

Sorties:

- `mermaid`: diagramme sequence
- `json`: `SequenceModel` + méta cache/perf
- `text/markdown`: résumé + warnings + stats

### MCP tool

Nouveau tool:

- `graphitlive_generate_sequence_diagram`

Input:

- `filePath` (absolu, validé)
- `symbolName`
- `maxDepth?`, `maxSteps?`
- `includeExternal?`, `includeAnnotations?`
- `diagram_format?` (`mermaid|json`)
- `response_format?` (`json|markdown|toon`)

Output:

- `diagram`
- `rootSymbol`
- `participantsCount`
- `messagesCount`
- `truncated`
- `warnings[]`
- `cache` (`hit`, `level`)
- `analysisTimeMs`

### Extension/webview

Nouveau command VS Code:

- `graph-it-live.showSequence`

Nouveau mode:

- `sequence` (panel dédié, séparé du call graph)

Messages extension → webview (nouveaux):

- `showSequenceDiagram`
- `sequenceLoading` / `sequenceIndexing`

Messages webview → extension (nouveaux):

- `sequenceOpenFile`
- `sequenceFocusSymbol`
- `sequenceDepthChanged`
- `sequenceFilterChanged`

---

## Fidélité: règles et garanties

### Garanties obligatoires

1. **Déterminisme**: même entrée/options/code => même diagramme
2. **Traçabilité**: chaque message mappe vers fichier/ligne/capture
3. **Aucune invention**: ambigu = marqué explicitement
4. **Ordre stable**: tri lexical + tie-break stable

### Confidence model

- `high`: résolution univoque
- `medium`: résolution probable mais contexte partiel
- `low`: fallback externe ou ambigu
- `unresolved`: non résolu, explicité

### Politique d’ambiguïté

- jamais masquer incertitude
- toujours exposer warning actionnable
- jamais “guess silencieux”

### Limite explicite

“Parfaite” en MVP = parfaite dans domaine **statiquement résoluble**.  
Le dynamique pur (reflection, runtime-dispatch opaque) est signalé comme incertain, pas simulé.

---

## Lisibilité et UX

### Règles Mermaid

- naming participant stable + alias anti-collision
- différenciation visuelle externes/internes
- flèches distinctes sync/return/async
- collapse appels répétitifs (`xN`) en mode compact
- truncation explicite si limites atteintes

### Panel Sequence (dédié)

Contrôles:

- `depth`
- `include external`
- `include annotations`
- `collapse repeats`
- export (`.mmd`, `.md`, `.json`)

Interactions:

- click message => open file at line
- click participant => recentrer depuis symbole

Observabilité UX:

- indicateur cache hit (memory/disk/miss)
- warnings visibles sans ouvrir logs

---

## Performance / NFR

### Cibles

- cache hit: ressenti instantané
- compute path: rapide sur projet moyen
- dégradation contrôlée sur monorepo géant

### Garde-fous

- `maxDepth`, `maxSteps`, `maxParticipants`
- segmentation/chunking automatique si dépassement
- jamais bloquer extension host (batch + yield)

### Robustesse

- aucune exception non gérée pour edges non résolus
- messages d’erreur explicites et actionnables

### Sécurité

- validations path/symbol identiques aux tools existants
- limites payload et taille output
- protections path traversal

---

## Stratégie de tests

### Unit

- résolution edge -> message
- annotations async/return/throws
- confiance/warnings
- cache key, invalidation, version bump

### Integration CLI/MCP

- parité sorties (même root/options)
- formats (`mermaid/json/markdown/toon`)
- comportement `--no-cache`

### E2E extension

- commande `showSequence`
- rendu panel + interactions navigation
- mise à jour sur save + invalidation cache

### Golden snapshots

- fixtures multi-langages (TS/JS/Python/Rust/C#/Go/Java)
- snapshots Mermaid déterministes

---

## Rollout

### Phase 1 (MVP)

- SequenceEngine + cache L1/L2
- CLI command
- MCP tool
- panel Sequence dédié

### Phase 2

- optimisations monorepo (pré-warm ciblé, invalidation plus fine)
- tuning lisibilité (collapse heuristics avancées)

### Phase 3

- amélioration résolution par langage
- métriques qualité exposées pour suivi régression

---

## Risques et mitigations

1. **Ambiguïtés nombreuses sur code dynamique**  
   Mitigation: confidence + unresolved explicites + warnings

2. **Diagrammes trop volumineux**  
   Mitigation: caps + segmenting + mode compact

3. **Coût monorepo**  
   Mitigation: cache obligatoire + invalidation incrémentale + limites configurables

---

## Décisions validées

- Approche 3 (hybride) validée
- Cache nécessaire et obligatoire pour monorepos
- Couverture MVP: CLI + MCP/tools + panel plugin dédié
- Source vérité: statique Tree-sitter, sans runtime instrumentation MVP
- Couverture langage phase 1: TS/JS/Python/Rust/C#/Go/Java
