# Rétro Sprint Bugfix #114 — FileReader Timeout (2026-06-19)

## Métriques Sprint

- **Durée** : 1 session (~1h)
- **Tests** : 1801 pass, 0 fail (164 fichiers)
- **Type check** : Clean (tsc --noEmit)
- **Pre-commit hooks** : PASS (layer isolation)
- **Pre-push hooks** : PASS
- **Fichiers modifiés** : 4 (FileReader.ts, SpiderDependencyAnalyzer.ts, 2 test files)
- **Fichiers créés** : 1 (SpiderDependencyAnalyzer.test.ts)
- **Insertions/suppressions** : +124 / -29 (net +95)
- **Gates bloqués** : 0

## Livrable

**Issue #114** : CLI crashait avec TIMEOUT unhandled rejection sur gros fichiers GraphQL (19MB Prisma schema).

**Root cause** : Timer `setTimeout()` démarrait AVANT `fs.stat()`. Si stat prenait du temps, timeout rejetait avant que la taille soit vérifiée. Rejet non attrapé = crash Node.js 15+.

**Fix implémenté** (2 niveaux) :
1. **FileReader.ts** : `fs.stat()` avant créer le timer + `clearTimeout()` sur tous les chemins sortie
2. **SpiderDependencyAnalyzer.ts** : `FILE_TOO_LARGE` et `TIMEOUT` → skip file (retour `[]` + warning) au lieu de crash

**Tests ajoutés** :
- FileReader.test.ts (existant) : +2 tests (stat-before-timer regression, cleanup)
- SpiderDependencyAnalyzer.test.ts (créé) : 3 tests (skip FILE_TOO_LARGE, skip TIMEOUT, rethrow PARSE_ERROR)

---

## KEEP (3 pratiques à reproduire)

1. **Stat avant timer** — Évite race condition entre I/O lent et timeout. Toujours vérifier les conditions préalables (taille, existence) AVANT les callbacks temporisés. Appliquable à tout handler avec contraintes temps.

2. **Deux couches de résilience** — Prevention (FileReader) + resilience (SpiderDependencyAnalyzer). Le premier bloque le bad case, le second absorbe si le bad case arrive de source externe. Pattern robuste pour criticité moyenne.

3. **Regression test + cleanup test** — FileReader.test.ts ligne 105-124 : test avec fake timers + avancement du temps confirmant que stat gagne la race, ET test avec timers réels confirmant clearTimeout() empêche dangling rejection. Double validation du fix.

---

## DROP (3 pratiques à abandonner)

1. **Timeout AVANT stat sur fichiers I/O-contraints** — L'ancien code (non commité mais mentionné dans l'issue) démarrait le timer immédiatement. Abandon = plus jamais timer avant prerequisite check. Responsabilité : dev, détectée par revue d'architecture.

2. **Crash silencieux sur FILE_TOO_LARGE** — Ancien SpiderDependencyAnalyzer rethrowait tout. Maintenant on skip + warn. À généraliser : skip resilience pour tout fichier > threshold (taille, temps parse). Pas d'exception pour grandes données, adaptation silencieuse.

3. **Fake timer sans cleanup vérification** — Tests qui moient `vi.useFakeTimers()` sans vérifier que les timers sont clearés. Notre test ligne 117-124 utilise timers réels pour cette vérification. Règle : si le code appelle `setTimeout()`, au moins 1 test doit vérifier `clearTimeout()` a été appelé ou que pas de dangling rejection.

---

## TRY (3 expérimentations)

1. **Streaming pour tous fichiers > 1MB** — FileReader.ts ligne 119 autorise déjà streaming si `stats.size > 1MB`. À tester en prod : impact RAM sur bulk scan très gros projets. Métrique : heap usage lors scan Prisma monorepo 500MB+ codebase.

2. **Pattern "skippable errors" dans analyzer** — SpiderDependencyAnalyzer.test.ts ligne 27-42 isole FILE_TOO_LARGE et TIMEOUT comme "skippable". À appliquer à LspCallHierarchyAnalyzer et SymbolAnalyzer : errors threshold-bound doivent skip + warn, pas crash. Tester : analyse d'un gros projet avec files > maxSize.

3. **Timeout configurable par handler** — FileReader constructor accepte déjà `timeout` option. À utiliser : faire timeout ≠ pour LanguageService vs ReverseIndexManager (parsing lent vs indexing lent). Métrique : % de TIMEOUT par handler type.

---

## Patterns Récurrents

- **I/O + timing** : 2e fois cette session que race condition I/O-timer en vient. Candidat pour règle universelle : "I/O prerequisite check avant any time-bound callback."
- **Deux couches résilience** : FileReader.ts + SpiderDependencyAnalyzer.ts = première fois. Tester sur autres analyzers (Lsp, Symbol, ReverseIndex).

---

## Notes Implémentation

- Couverture : FileReader déjà testée (tests existants), SpiderDependencyAnalyzer test créé (3 tests). Hugo valide couverture fichiers touchés > 80%.
- Cross-platform : normalizePath() appliqué cohérent dans SpiderDependencyAnalyzer ligne 24, 52.
- Layer isolation : FileReader (pure Node.js analyzer) respecte règle 01, test isole error types. SPiderDependencyAnalyzer appelle languageService (abstrait handler), pas vscode import.

---

## Leçons à Capitaliser

1. "Stat before timer" → ajouter à .claude/rules/timing-patterns.md si créé
2. "FILE_TOO_LARGE skip not crash" → règle de résilience pour tous analyzer parsers
3. "Fake timer + real timer test" → ajouter exemple FileReader.test.ts à rules/testing.md
