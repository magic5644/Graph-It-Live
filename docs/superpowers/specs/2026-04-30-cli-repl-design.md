# CLI REPL Guidé — Design Spec

**Date:** 2026-04-30  
**Statut:** Approuvé  
**Scope:** Phase 1 MVP — mode interactif pour `graph-it`

---

## Contexte et motivation

Le CLI `graph-it` compte ~659 téléchargements/mois sur npm, ce qui témoigne d'une audience réelle qui choisit le CLI plutôt que l'extension VS Code. Cette audience souffre de trois frictions :

1. **Découverte** — l'utilisateur ne sait pas quelle commande utiliser ni comment formuler son analyse
2. **Navigation dans les résultats** — les outputs en texte brut sont difficiles à explorer
3. **Enchaînement** — plusieurs commandes successives pour une analyse complète, sans contexte partagé

La solution retenue est un **REPL guidé** (`graph-it` sans argument) qui orchestre les commandes existantes via une interface de prompts interactifs, sans réimplémenter la logique d'analyse.

---

## Approche retenue

**REPL guidé avec `@inquirer/prompts`** — façade interactive sur les commandes existantes.

Deux autres approches ont été évaluées et écartées :
- **UI locale navigateur** (`graph-it ui`) : plus riche mais 3-4 semaines d'effort ; validé comme Phase 2 une fois l'audience CLI confirmée
- **TUI (Terminal UI)** avec `blessed`/`ink` : les graphes de dépendances sont visuels par nature, les forcer en ASCII plafonne l'UX rapidement

---

## Architecture

### Nouveaux fichiers

```
src/cli/
├── commands/repl.ts        ← point d'entrée du mode interactif, boucle principale
├── repl/
│   ├── prompts.ts          ← toutes les questions @inquirer/prompts
│   ├── fileSearch.ts       ← fuzzy search sur les fichiers du workspace
│   └── sessionState.ts     ← contexte de session (fichier courant, historique)
```

### Déclenchement

Dans `src/cli/index.ts` : si `process.argv.length === 2` (aucun argument) **et** `process.stdin.isTTY === true`, router vers `commands/repl.ts`. Comportement inchangé pour toutes les commandes existantes.

```bash
graph-it            # → lance le REPL
graph-it scan       # → mode non-interactif (inchangé)
graph-it --help     # → aide (inchangée)
```

### Dépendance ajoutée

`@inquirer/prompts` uniquement — ~40KB, zéro dépendance transitive, maintenu par l'équipe npm, support Windows natif.

---

## Flux UX

```
graph-it (sans arg, TTY)
  └─ Menu principal
       ├─ Analyser un fichier ou symbole
       │    ├─ Fuzzy search fichier (Spider.getAllFiles())
       │    ├─ Sélection symbole optionnelle (filtrée)
       │    └─ → runTrace() → affichage résultat
       ├─ Cartographier les dépendances d'un fichier
       │    ├─ Fuzzy search fichier
       │    └─ → runPath() → affichage résultat
       ├─ Trouver du code mort
       │    └─ → runCheck() → affichage résultat
       ├─ Résumé du workspace
       │    └─ → runSummary() → affichage résultat
       └─ Quitter

  Après chaque résultat :
       ├─ Explorer un nœud de ce graphe  (re-appelle trace avec un symbole du résultat)
       ├─ Exporter  (json / markdown / mermaid)
       ├─ Nouvelle analyse  (retour menu principal)
       └─ Quitter
```

---

## Composants

### `commands/repl.ts`
Boucle principale `while (!quit)`. Appelle `prompts.ts` pour obtenir l'intention de l'utilisateur, puis délègue aux fonctions des commandes existantes. Capture toutes les erreurs et les présente inline au lieu de `process.exit()`.

### `repl/sessionState.ts`
Objet en mémoire (pas de persistence disque) :
```typescript
interface SessionState {
  workspaceRoot: string;
  lastFile?: string;
  lastResult?: AnalysisResult;
  preferredFormat: OutputFormat;  // défaut: 'text'
}
```
Évite de re-saisir le workspace et le fichier courant à chaque étape.

### `repl/fileSearch.ts`
Fuzzy search sur la liste de fichiers retournée par `Spider.getAllFiles()`. Filtre en temps réel pendant la saisie via `@inquirer/prompts` autocomplete. Utilise une correspondance simple par sous-chaîne sur le chemin relatif (pas de dépendance fuzzy externe).

### `repl/prompts.ts`
Toutes les questions inquirer centralisées. Séparées de la logique REPL pour faciliter les tests et l'évolution indépendante.

---

## Gestion des erreurs

Le REPL intercepte les erreurs au lieu de terminer le process :

| Situation | Comportement REPL |
|---|---|
| Workspace introuvable | "Aucun workspace détecté. Scanner maintenant ? (o/n)" |
| Index absent ou périmé | "L'index est vieux ou absent. Scanner maintenant ? (o/n)" |
| Symbole ambigu | Liste de choix proposée directement dans le prompt de sélection |
| Erreur d'analyse | Message d'erreur + "Retour au menu" |
| `Ctrl+C` au menu principal | Quitte proprement |
| `Ctrl+C` pendant un prompt | Retour au menu (pas de quit) |

### Non-TTY / CI

Si `process.stdin.isTTY === false`, le REPL refuse de démarrer et affiche :
```
Mode interactif non disponible (pas de TTY).
Utilise les commandes directes : graph-it --help
```
Le comportement CLI classique reste intact pour les scripts, pipes, et CI.

---

## Tests

Aucune nouvelle infrastructure — Vitest est déjà en place.

**Ajouts dans `tests/cli/` :**
- `repl.test.ts` — tests unitaires de `sessionState.ts` (state management) et `fileSearch.ts` (logique de filtrage)
- Les prompts inquirer ne sont pas testés unitairement (difficile à mocker proprement) ; les commandes sous-jacentes ont leurs propres tests
- Tests E2E via `test-cli-e2e.sh` si nécessaire pour le flux complet

---

## Périmètre explicitement hors scope (Phase 1)

- Persistence de l'historique de session entre exécutions
- Coloration syntaxique des outputs (chalk ou similaire)
- Mode `graph-it ui` avec navigateur local (Phase 2)
- Configuration du format par défaut dans `.graph-it/config`

---

## Chemin vers la Phase 2

Le REPL valide les use cases et l'appétit utilisateur. Si les signaux sont positifs (issues, feedback, adoption), la Phase 2 (`graph-it ui`) réutilise :
- Le protocole de messages déjà typé (`src/shared/messages.ts`)
- Les composants React/ReactFlow/Cytoscape existants
- Les guards `typeof acquireVsCodeApi === "function"` déjà en place dans le webview

Effort estimé Phase 2 : 3-4 semaines.
