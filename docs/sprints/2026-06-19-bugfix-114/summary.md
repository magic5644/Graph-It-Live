# Sprint Bugfix #114 — 2026-06-19

## Livrable

**Issue** : [#114](https://github.com/magic5644/Graph-It-Live/issues/114) — CLI crash timeout sur gros fichiers GraphQL  
**PR** : [#115](https://github.com/magic5644/Graph-It-Live/pull/115)  
**Version** : v1.9.8  
**Branche** : `fix/114-filereader-timeout-before-stat`

## Commits

- `b953da9` fix: move stat before timeout timer in FileReader, skip large/slow files
- `d1149d3` chore: add v1.9.8 changelog entry for FileReader timeout fix (#114)

## Fichiers modifiés

- `src/analyzer/FileReader.ts` — stat avant timer + clearTimeout
- `src/analyzer/spider/SpiderDependencyAnalyzer.ts` — skip FILE_TOO_LARGE/TIMEOUT
- `tests/analyzer/FileReader.test.ts` — 2 tests ajoutés
- `tests/analyzer/SpiderDependencyAnalyzer.test.ts` — nouveau (3 tests)
- `changelog.md` — entrée v1.9.8

## Métriques

- Tests : 1801 pass, 0 fail
- Types : clean
- Gates bloqués : 0
- Durée : ~1h
