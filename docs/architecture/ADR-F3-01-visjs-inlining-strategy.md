# ADR-F3-01 — Stratégie d'inlining vis.js dans le HTML autoportant

**Date** : 2026-06-29  
**Statut** : Accepted

## Contexte
Story F3 produit un HTML autoportant (zéro dépendance réseau) avec vis-network (~1.5MB minifié). CLI distribué via `npm install -g graph-it-live` ; `vis-network` est dans `dependencies`, présent dans le `node_modules` global du package.

## Décision
Lecture au runtime via `createRequire(import.meta.url)` (compatible ESM) + `fs.readFileSync` sur le bundle `vis-network/standalone/umd/vis-network.min.js`. Inlining dans `<script>` du HTML généré.

## Conséquences
+ HTML totalement autoportant, consultable hors ligne  
+ `require.resolve` depuis le module CLI résout dans le bon `node_modules` global  
+ Erreur explicite si `vis-network` absent (`MODULE_NOT_FOUND`)  
− HTML généré ~1.5MB — acceptable pour un artefact de visualisation one-shot  
− I/O synchrone ~1.5MB par export — acceptable pour CLI non-interactif  

## Alternatives rejetées
- CDN (unpkg) : rompt l'exigence autoportant  
- Bundle dans `dist/graph-it.js` via esbuild : gonfle le CLI de 1.5MB, risque .map dans .vsix  
- Cache `~/.cache/graph-it/` : complexité injection/invalidation injustifiée  
