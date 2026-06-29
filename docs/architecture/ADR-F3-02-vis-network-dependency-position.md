# ADR-F3-02 — `vis-network` : dependencies vs devDependencies

**Date** : 2026-06-29  
**Statut** : Accepted

## Contexte
`vis-network` est lu à runtime par le CLI via `fs.readFileSync` (pas importé statiquement). Position dans `package.json` détermine présence en install production et impact sur bundle esbuild.

## Décision
`dependencies` (pas `devDependencies`).

## Conséquences
+ `npm install -g graph-it-live` installe `vis-network` → `require.resolve` fonctionne  
+ Pas d'import statique → esbuild ne bundle pas vis-network → zéro .map dans .vsix (règle 02 ✓)  
− `node_modules` global +~8MB — acceptable pour dépendance runtime légitime  
− Utilisateurs n'utilisant pas `--format html` portent le poids  

## Alternatives rejetées
- `devDependencies` : absent en `npm install --production` et CI Docker → `MODULE_NOT_FOUND` en production  
- `optionalDependencies` : sémantique incorrecte (requis pour la feature, pas optionnel)  
