# État de ma branche — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task. Use `subagent-driven-development` only if delegation is explicitly requested. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permettre au développeur de voir automatiquement les points de vigilance de ses modifications par rapport à une branche de référence, sans commande à lancer à chaque changement et sans surcharger l’IDE.

**Architecture:** Utiliser le graphe de dépendances du Spider pour un socle multilangage et `ReviewGateAnalyzer` comme enrichissement de signatures TS/JS, jamais comme filtre d’entrée de la feature. Ajouter une orchestration optionnelle dans l’extension, un indicateur de barre d’état et une Tree View native dans le conteneur Graph-It-Live existant. Limiter la feature aux constats structurels ; afficher un rappel que les tests doivent être exécutés avec succès, sans collecter ni valider leurs résultats.

**Tech Stack:** TypeScript strict, Node.js 22+, API stable VS Code compatible avec la version minimale du manifeste, Git local, Vitest et tests VS Code Electron existants. Aucune nouvelle dépendance prévue.

**Spec:** La section « Spécification produit » de ce document formalise les échanges utilisateur ; les choix signalés « proposition » restent à valider lors de la reprise. Référence concurrentielle : [competitive-graphify.md](../../strategy/competitive-graphify.md), dont la priorité webview initiale n’est pas retenue ici.

**État :** implémentation intégrée et plan conservé comme historique des décisions, mis à jour le 20 septembre 2026. Les cases décrivent le déroulé initial ; les comportements effectivement exposés sont ceux du code et du README. Des modifications utilisateur préexistent dans le workspace ; ne pas les inclure dans les commits de cette feature.

## Contraintes globales

- Node.js 22+ ; conserver la version minimale VS Code déclarée dans `package.json`.
- `src/analyzer/**` et `src/mcp/**` restent Node-only ; aucune importation `vscode`.
- Feature désactivée par défaut ; zéro analyse, timer ou abonnement Git spécifique tant qu’elle est désactivée. Un listener de configuration et les contributions déclaratives peuvent exister.
- Aucun fetch, checkout, stash, changement d’index Git, installation, envoi réseau ou lancement automatique de tests.
- Ne pas modifier la webview React ni son protocole pour cette version ; Tree View native.
- Préserver les interfaces publiques CLI/MCP, leurs champs existants, options, codes de sortie et scores. Un enrichissement partagé n’est permis que si nécessaire, additif, documenté et couvert par les tests de compatibilité de A5. Aucun couplage du CLI aux settings ou à la présence de VS Code.
- Pas de promesse de sécurité applicative, de couverture exhaustive ou de validation de tous les changements.
- Lire les règles routées par `AGENTS.md` avant chaque tâche ; Graph-It-Live MCP avant exploration JS/TS ; commandes shell préfixées `rtk`.
- Tests succès et erreurs/limites ; couverture ≥80 % de chaque fichier source touché ; E2E pour settings, commandes et interactions.
- Toutes les chaînes visibles ou retournées par le plugin, le CLI et le MCP sont en anglais : titres, boutons, statuts, recommandations, erreurs, limites, JSON/TOON/Markdown et messages destinés à l’utilisateur. Le français de ce plan ne doit jamais être copié dans le produit.

## Spécification produit

### Besoin et périmètre

Le diff Git répond « qu’est-ce qui a changé ? ». La feature répond « quels consommateurs, tests et limites d’analyse dois-je examiner avant de livrer ? ».

Comparer le contenu local enregistré au **merge-base entre HEAD et la branche de référence**. Cela inclut les commits de la branche et l’état final du working tree, staged et unstaged. Ce n’est pas une revue du seul prochain commit : une modification staged ensuite annulée dans le working tree suit le contenu final sur disque. Les buffers non enregistrés sont signalés mais ne sont pas analysés.

Une seule livraison est prévue : **suivi structurel automatique multilangage**, avec état Git, impact au niveau fichiers, enrichissement de signatures TS/JS, consommateurs à examiner et limites explicites. Les identifiants de tâches A0–A5 sont conservés pour faciliter la reprise.

Concernant les tests, afficher simplement : **“Tests must pass before delivery.”** Ce rappel est informatif : aucune exécution, lecture de rapport, intégration de runner, validation de couverture ou attestation de réussite par le plugin. Il n’ajoute pas à lui seul un WARNING permanent.

Hors périmètre : SAST, CVE, secrets, analyse de flux de données, auto-fix, génération de tests, couverture de lignes modifiées, prédiction des bugs dans le corps des fonctions, gate bloquant le commit, analyse multi-repositories simultanée.

### Couverture multilangage — correction du périmètre initial

La feature ne doit pas réserver son utilité aux fichiers TS/JS. Le socle commun part des **fichiers modifiés**, pas uniquement des symboles dont une signature a changé. L’inventaire Git concerne tous les fichiers ; l’analyse de relations dépend des capacités réelles du moteur.

| Langages / fichiers | Socle requis dans A | Enrichissement disponible ou limite |
| --- | --- | --- |
| TS / JS | Fichiers modifiés, dépendants directs/transitifs bornés | Comparaison de signatures existante |
| Python / Rust | Même impact au niveau fichiers | Graphe d’appels existant pour exploration ; comparaison de signatures non promise |
| C# / Go / Java | Même impact au niveau fichiers | Call graph disponible ; ne pas dépendre de la Symbol View absente |
| Vue / Svelte | Même impact au niveau fichiers | Ne pas confondre support des graphes avec support du comparateur de signatures |
| GraphQL | Impact au niveau fichiers selon les relations résolues | Pas de vérification de compatibilité de schéma ni de call graph promise |
| Autres langages, configurations et documents | Inventaire visible et effet sur la fraîcheur | Analyse des dépendances non disponible signalée ; aucune supposition d’absence d’impact |

Source de couverture : [README](../../../README.md#supported-languages). Les relations effectivement résolues doivent être vérifiées sur des fixtures par langage ; cette matrice ne promet ni exhaustivité ni traversée des frontières de services, HTTP, FFI ou génération de code.

Exemple Python : `billing.py` modifié → `api.py` et `jobs.py` dépendent de ce fichier → points à examiner ; aucun diagnostic “broken signature” sans comparateur adapté. La présence de consommateurs est d’abord un contexte d’impact, pas automatiquement une alerte. Sans changement de contrat démontré, le simple fait qu’un consommateur soit inchangé ne suffit pas à le classer comme oubli de propagation.

Les associations statiques de tests déjà fournies par le moteur peuvent rester des liens utiles, mais ne prouvent aucune exécution. Ne pas ajouter de détection de tests par langage pour cette feature ; le rappel de réussite attendue est identique pour tous les langages.

### UX proposée

Un seul indicateur, un seul lieu de détail. Aucun popup, aucun panneau ouvert automatiquement, aucun diagnostic rouge ajouté dans l’éditeur.

```text
Status bar:  ⑂ main · ⚠ 3 checks

Conteneur Graph-It-Live
  Branch status                              [Pause] [↻] [Base]
    feature/users → main · updated at 14:32
    ⚠ WARNING · structural analysis
    ▾ Consumers to review
        findUser: required parameter added
          admin.service.ts — consumer unchanged
          user.controller.ts — changed; compatibility unproven
    ▾ Cyclic dependencies
        ⚠ New cycle introduced : api.ts → service.ts → api.ts
          A design change or decomposition is probably required.
    ▾ Tests
        Tests must pass before delivery.
    ▾ Limitations
        legacy.ts deleted — deletion impact not analyzed
```

- Clic indicateur : révèle/focalise `graph-it-live.branchWatchView`.
- Clic fichier : ouvre sa source, à la ligne si disponible ; sans ligne, ouvre le fichier sans en inventer une.
- Action sur symbole : réutilise `graph-it-live.reviewCallGraph` avec un objet validé, sans fabriquer un URI `vscode://` spécifique à un hôte.
- Vue désactivée : texte d’accueil et bouton “Enable branch watch”. Pas de statut permanent.
- Toolbar : pause/reprise de session, actualisation, choix de référence. Le menu secondaire ouvre le réglage de désactivation persistante.
- Icône + texte accessibles ; ne jamais dépendre uniquement du rouge/vert.
- Les exemples du bloc UI sont en anglais volontairement ; conserver cette convention dans le plugin, le CLI et le MCP, sans introduire une infrastructure de traduction.

### Configuration et limites fixes initiales

| Réglage proposé | Défaut | Portée et comportement |
| --- | --- | --- |
| `graph-it-live.branchWatch.enabled` | `false` | Workspace folder ; activation explicite |
| `.graph-it/branch-watch.json` (`baseRef`, `headRef`) | chaînes vides | Préférences locales au workspace, ignorées par Git ; les réglages `graph-it-live.branchWatch.baseRef/headRef` ne servent que de fallback de migration |

Proposer la branche distante par défaut lorsqu’elle est connue, sinon les références `main`/`master` existantes. La référence doit être confirmée une fois ; ne pas prendre automatiquement l’upstream de la feature comme base stable. Aucun fetch. Afficher “local reference” et son SHA dans le détail.

Constantes initiales proposées : regroupement de 1 000 ms après la dernière sauvegarde/notification Git, 200 fichiers maximum, profondeur 3, une analyse à la fois. Conserver ces constantes internes tant qu’un besoin ne justifie pas plus de settings. Pause en mémoire, perdue au redémarrage ; la désactivation persistante annule toute publication et masque le statut.

### Dossier sans Git

Le suivi de branche exige un dépôt Git reconnu dans la racine du workspace. L’ouverture d’un simple dossier, d’un dépôt Git non initialisé, d’un sous-dossier dont la racine Git est ambiguë, ou d’un dépôt géré par un autre VCS non supporté ne doit pas être traitée comme une branche propre.

- La vue reste disponible et affiche **“Branch watch unavailable”**, puis une raison en anglais : **“This workspace is not a supported Git repository.”**
- Le bouton **“Enable branch watch”** est désactivé tant qu’une racine Git valide n’est pas détectée ; aucune référence, comparaison, surveillance Git, timer ou analyse de branche n’est lancé.
- Le graphe de dépendances, la Symbol View, le Live Call Graph et les outils CLI/MCP normaux continuent de fonctionner ; seule cette feature est indisponible.
- Si le dépôt est initialisé ou si un workspace est rechargé, écouter le changement de racine et proposer **“Retry branch detection”**. Ne pas lancer de `git init`, ne pas créer de branche et ne pas proposer un VCS équivalent sans adaptateur explicitement implémenté.
- Si Git est installé mais la racine est inaccessible, les permissions insuffisantes, le dépôt en conflit ou la branche sans commit, afficher **“Branch watch unavailable”** avec la cause précise ; ne jamais convertir l’erreur en “No recorded changes” ou “Structure: OK”.

La première version supporte Git uniquement. Un futur adaptateur Mercurial, SVN ou autre devra fournir les mêmes garanties (référence stable, merge-base ou équivalent, état local, événements et empreinte) avant d’être affiché comme supporté.

### Statut : règles pour éviter les faux feux verts

Séparer le cycle de vie du résultat. Le risque numérique de `ReviewGateAnalyzer` reste une donnée technique, pas un deuxième badge LOW/MEDIUM/HIGH.

| État affiché | Condition et texte attendu |
| --- | --- |
| Disabled | No indicator |
| Paused | Historical result clearly marked; no active green status |
| Save required | Relevant buffer changed; last saved analysis is stale |
| Running | Analysis or index preparation in progress; previous result is stale |
| Unverified | Reference missing, unsupported Git repository, Git/index unavailable, or context unsupported |
| WARNING | Structural point to review, touched/introduced cycle, analysis limitation, or stale structural result |
| KO | Not used for this scope: structural heuristics do not prove failure; analysis errors produce Unverified |
| OK (structural) | Current analysis has no alert or limitation in supported checks; does not validate tests or application behavior |

Une branche sans alerte ni limite affiche “Structure: OK”. Sans changement : “No recorded changes”. Le rappel concernant les tests reste visible dans la vue, sans influer sur le statut structurel. Aucun statut ne signifie “ready to ship” ou “tests passed”.

### Cyclic dependencies

Le statut cyclique compare le graphe du `merge-base` de la référence avec celui de l’état courant. Il ne suffit pas de voir qu’un fichier modifié appartient aujourd’hui à un cycle : ce cycle peut être ancien et sans rapport avec la branche.

- **Introduced cycle**: aucune arête cyclique équivalente dans la baseline, cycle détecté dans l’état courant, et au moins une arête est nouvelle ou modifiée.
- **Aggravated cycle**: cycle déjà présent, mais une nouvelle arête ou un fichier modifié rejoint le cycle ou augmente le chemin concerné.
- **Existing cycle touched**: le cycle existait avant et une modification courante concerne un de ses fichiers, sans preuve qu’elle l’a créé.
- **Existing cycle untouched**: ne pas l’afficher dans la vue de vigilance ; conserver seulement le compteur global de l’outil existant.

Chaque entrée affiche les chemins relatifs du cycle, la relation ajoutée/modifiée lorsqu’elle est connue, la baseline (« absent », “already present”) et la limite éventuelle. Le texte **“A design change or decomposition is probably required”** est une recommandation de revue, pas une correction automatique ni la preuve qu’un cycle est toujours un bug. Proposer “Open cycle in graph” et laisser le développeur décider.

Comparer des arêtes normalisées `source`, `target` et relation quand celle-ci est disponible. Si un langage ne fournit qu’un graphe de fichiers, parler de **cycle de dépendances de fichiers** ; ne pas le présenter comme cycle d’appels. Si l’index est incomplet, afficher “Cycle cannot be determined” plutôt que “no cycles”.

Les champs de tests éventuellement renvoyés par `ReviewGateAnalyzer` ne sont pas interprétés par cette feature. Un consommateur modifié n’est pas nécessairement corrigé ; un consommateur inchangé n’est pas nécessairement cassé. Les changements du corps d’une fonction et les nouveaux fichiers doivent apparaître dans le périmètre avec “behavior unverified” lorsque le moteur ne fournit aucune preuve pertinente.

## État technique vérifié et conséquences

| Existant | Réutilisation / limite |
| --- | --- |
| `src/analyzer/ReviewGateAnalyzer.ts` | Revue bornée des signatures TS/JS et consommateurs ; `analyze({baseRef: mergeBaseSha})` compare au disque si `headRef` est omis |
| `getChangedFiles()` dans ce même fichier | Filtre ACMR : suppressions exclues ; pas de non-suivis ; parsing par lignes fragile pour noms spéciaux. Corriger le parsing sans élargir silencieusement le contrat de revue |
| `src/mcp/tools/impact.ts` | `createSpiderDependentsProvider` décrit les 4 bindings Spider ; éviter d’importer ce module et son état worker dans l’extension |
| `src/extension/GraphProvider.ts` | `getSpiderForLmTools()` donne accès au Spider ; `handleFileChange()` attend l’event hub. Réutiliser l’accès, sans refactor de nommage hors scope |
| `src/extension/services/FileChangeScheduler.ts` | Debounce par fichier, pas ordonnanceur global de revue ; ne pas changer sa sémantique pour la feature |
| `src/extension/services/ExtensionEventHub.ts` | `handleFileChange()` attend `spider.reanalyzeFile()` pour create/change et appelle `handleFileDeleted()` pour delete, puis persistance et rafraîchissement ; observer la fin de cette voie pour éviter une double réanalyse |
| `src/extension/services/CommandRegistrationService.ts` | Navigation `reviewCallGraph` existante |
| `package.json` | Conteneur `graph-it-live-explorer` déjà présent : y ajouter une Tree View, pas un nouvel Activity Bar container |
| `src/extension/extension.ts` | Cycle activate/dispose et choix de workspace ; changement de workspace du graphe requiert actuellement un reload |

Limite connue multi-root : A suit uniquement la racine du Spider actif. Afficher cette racine ; si le dépôt choisi ne correspond pas, arrêter et demander une sélection cohérente/reload. Ne pas reconstruire la gestion multi-root dans cette feature. Pour un sous-dossier de dépôt, A exige que la racine analysée corresponde au dépôt ; autrement état non supporté explicite.

## Architecture et fichiers prévus

Les nouveaux noms ci-dessous sont proposés, pas déjà présents.

| Fichier | Responsabilité |
| --- | --- |
| Créer `src/analyzer/BranchWatchAnalyzer.ts` | Inventaire Git complet, baseline, empreinte, impact multilangage par fichiers et enrichissement par revue de signatures ; exports des types du résultat |
| Modifier `src/analyzer/ReviewGateAnalyzer.ts` | Parsing Git NUL et options de diff sûres ; préserver API et scoring existants |
| Créer `src/extension/services/BranchWatchService.ts` | Settings, événements, préparation index, génération courante, lifecycle, statut et actions |
| Créer `src/extension/services/BranchWatchTreeProvider.ts` | Projection du résultat en TreeItems ; pas d’analyse Git |
| Modifier `src/extension/GraphProvider.ts` | Point minimal d’observation de fin d’actualisation si nécessaire ; aucune logique métier supplémentaire |
| Modifier `src/extension/extension.ts` | Instanciation, injection Spider et disposal |
| Modifier `package.json` | Settings, Tree View, accueil et commandes de toolbar |
| Tests associés | `tests/analyzer/BranchWatchAnalyzer.test.ts`, `tests/analyzer/ReviewGateAnalyzer.test.ts`, `tests/extension/services/BranchWatchService.test.ts`, `tests/extension/services/BranchWatchTreeProvider.test.ts`, `tests/extension/GraphProvider.test.ts`, `tests/vscode-e2e/suite/branchWatch.test.ts`, et `tests/vscode-e2e/runTests.ts` pour sélectionner un workspace temporaire |
| Documentation | `README.md`, `DEVELOPMENT.md` : activation, limites et sens des statuts |

Ne pas extraire un framework générique. L’adaptation Spider peut être quatre fonctions liées à l’instance dans l’orchestrateur ; si une extraction commune devient nécessaire, elle doit rester dans analyzer et conserver les imports CLI/MCP existants par réexport.

## Contrats de réalisation

Contrat proposé dans `BranchWatchAnalyzer.ts` :

```ts
export interface BranchWatchChange {
  path: string; // relatif, normalisé, validé dans le workspace
  kind: 'added' | 'modified' | 'deleted' | 'untracked' | 'type-changed';
}
export interface BranchWatchSnapshot {
  reference: string;
  referenceSha: string;
  headSha: string;
  mergeBaseSha: string;
  fingerprint: string;
  changes: BranchWatchChange[];
  limitations: string[];
}
export interface BranchWatchFileImpact {
  path: string;
  dependents: Array<{ path: string; depth: number; changed: boolean }>;
  availability: 'available' | 'partial' | 'unavailable';
  limitations: string[];
}
export interface BranchWatchResult {
  fileImpacts: BranchWatchFileImpact[];
  cycles: BranchWatchCycleFinding[];
  snapshot: BranchWatchSnapshot;
  review: ReviewGateResult; // type existant de ReviewGateAnalyzer
  analyzedAt: number;
}
export interface BranchWatchCycleFinding {
  classification: 'introduced' | 'aggravated' | 'existing-touched';
  nodePaths: string[];
  edgeKeys: string[];
  changedPaths: string[];
  relation: 'file-dependency' | 'call' | 'mixed';
  recommendation: 'review-design';
  limitations: string[];
}
// Classe Node-only ; SymbolDependentsProvider est le type existant.
// constructor(root: string, dependents: SymbolDependentsProvider)
// capture(baseRef: string): Promise<BranchWatchSnapshot>
// analyze(snapshot: BranchWatchSnapshot): Promise<BranchWatchResult>
```

`analyze()` appelle `new ReviewGateAnalyzer(root, dependents).analyze({ baseRef: snapshot.mergeBaseSha, maxFiles: 200, maxDepth: 3 })`. Cet appel fournit seulement l’enrichissement de signatures. Pour chaque fichier modifié, `analyze()` construit aussi `fileImpacts` avec `findReferencingFiles` du provider, par parcours en largeur borné à profondeur 3 et 200 fichiers uniques par exécution, avec ensemble des chemins visités pour éviter les cycles. Fonction absente, index incomplet, langage non pris en charge ou borne atteinte : disponibilité partielle/indisponible explicite. Aucune arête ne doit être inventée. Il enrichit les limites issues de l’inventaire ; aucun résultat n’est publié avant une seconde capture identique. Les erreurs de Git/index sont présentées par l’orchestrateur comme non vérifiées.

Le même résultat calcule `cycles` en comparant les arêtes cycliques du graphe de référence et du graphe courant avec le détecteur existant. Les cycles sont filtrés après calcul afin de ne conserver que ceux dont une arête ou un fichier est touché par la branche ; un cycle ancien non touché ne crée aucune vigilance.

Contrat d’orchestration proposé :

```ts
type BranchWatchPhase =
  | 'disabled' | 'paused' | 'dirty' | 'pending'
  | 'running' | 'ready' | 'unavailable';

interface BranchWatchViewState {
  phase: BranchWatchPhase;
  result?: BranchWatchResult; // peut être historique ; phase prévaut
  reason?: string;
}
// BranchWatchService implements vscode.Disposable
// pause(): void ; resume(): void ; refresh(): void
// onDidChangeState: vscode.Event<BranchWatchViewState>
// BranchWatchTreeProvider : TreeDataProvider avec setState(state): void
```

La factory de la livraison A injecte dans le service le Spider actif et une fonction `prepareIndex(paths: readonly string[]): Promise<void>` ; celle-ci doit attendre la voie de mise à jour existante, pas seulement vérifier un booléen de readiness global. Si la préparation échoue, le service ne publie pas de résultat frais.

`Spider.subscribeToIndexStatus()` existe déjà pour la readiness initiale. Il ne remplace pas une barrière de fin de traitement des fichiers : ajouter cette notification au coordinateur existant si nécessaire, sans appeler une deuxième fois `reanalyzeFile()` depuis le suivi. Ne pas émettre la notification avant la résolution de `handleFileChange()` ; ne pas considérer son retour anticipé sur un langage non supporté comme une analyse réussie.

## Tâches — livraison A

### A0 — Vérifier les hypothèses d’intégration

**Fichiers lus :** ceux de la table ci-dessus, `src/analyzer/Spider.ts`, règles architecture/security/testing/quality-gates, tests existants de l’extension. Aucun changement fonctionnel pour cette étape.

- [ ] Vérifier branche et état Git ; créer `feat/branch-watch` ou un worktree seulement au démarrage de l’implémentation, en préservant les changements utilisateur.
- [ ] Ajouter une fixture E2E de dossier sans `.git`, une fixture Git non initialisée et une fixture avec Git inaccessible/non committé. Vérifier `Branch watch unavailable`, la cause en anglais, l’absence de timer/analyse et la disponibilité intacte du graphe normal.
- [ ] Utiliser le graphe puis tracer `handleFileChange()` jusqu’à l’actualisation des index. Identifier précisément le point d’attente pour `prepareIndex` ; consigner le résultat dans ce plan.
- [ ] Vérifier comment initialiser l’index sans ouvrir la webview : l’activation du suivi doit fonctionner seule. Si nécessaire, déclencher une seule initialisation existante, jamais un rebuild complet par sauvegarde.
- [ ] Vérifier que `vscode.git` expose `getAPI(1)` et `repository.state.onDidChange` sur la version minimale VS Code et sur Cursor ciblé. Utiliser uniquement la petite surface typée requise, avec validation de forme ; ne pas copier toute l’API Git.
- [ ] Définir une détection unique de racine Git et un résultat d’erreur typé (`not-a-repository`, `git-unavailable`, `unborn-head`, `ambiguous-root`, `unsupported-vcs`). Tester que chaque cause reste distincte dans le modèle, tout en utilisant le libellé utilisateur commun `Branch watch unavailable`.
- [ ] Confirmer les choix produit : opt-in, référence explicite, Tree View dans le conteneur existant, livraison A sans feu vert global. Ne pas introduire d’intégration de résultats de tests.

**Sortie :** points d’intégration confirmés et compatibilité explicitée ; si Git API manque, mode indisponible avec action d’aide, pas ajout immédiat d’un polling de secours.

### A1 — Capturer correctement la branche et ses limites

**Créer :** `BranchWatchAnalyzer.ts` et son test. **Modifier :** parsing de `ReviewGateAnalyzer.ts` et tests associés.

- [ ] Écrire des tests avec de petits vrais dépôts Git temporaires : commit commun, commits sur feature, avancement indépendant de main, modifications staged/unstaged, suppressions, ajout non suivi, renommage, chemin avec espace et saut de ligne.
- [ ] Faire échouer ces tests avant implementation.
- [ ] Résoudre la référence en SHA avec `execFile`, jamais une commande shell interpolée ; rejeter référence vide/commençant par `-`, puis `rev-parse --verify --end-of-options <ref>^{commit}`.
- [ ] Résoudre HEAD, puis `merge-base --all <referenceSha> <headSha>`. Zéro ou plusieurs ancêtres : non vérifié, aucune sélection arbitraire. Pas de fetch pour shallow clone ou historique absent.
- [ ] Lire `diff --no-ext-diff --no-textconv --no-renames --name-status -z <mergeBaseSha> --` et `ls-files --others --exclude-standard -z`. Traiter les renommages comme suppression + ajout pour A, avec une limite explicite.
- [ ] Lire aussi le statut de conflit : conflits → suspendre le résultat de revue et afficher “Resolve conflicts”. HEAD absent/détaché, sous-module ou racine incompatible → non vérifié explicite.
- [ ] Corriger `ReviewGateAnalyzer.getChangedFiles()` vers `--name-only -z`, parsing NUL, `--no-ext-diff --no-textconv` et séparateur final `--`. Garder le filtre historique ; inventorier les exclusions via `BranchWatchSnapshot.limitations`.
- [ ] Borner les sorties Git, le nombre/taille des fichiers et le temps des processus ; dépassement → limite/indisponibilité visible, jamais liste vide considérée saine.
- [ ] Calculer une empreinte SHA-256 avec HEAD, SHA référence, merge-base, inventaire, contenu des fichiers modifiés analysables ; marqueur distinct pour supprimés/ignorés. Capturer après l’analyse et jeter le résultat si l’empreinte diffère. Ne pas lire tous les fichiers du dépôt pour chaque capture.
- [ ] Valider chemins et realpath avant lecture/navigation : symlink extérieur refusé, type non régulier et gros/binaire signalés comme limites. `normalizePath()` avant clés de Map/Set.

Exemple de test de régression à intégrer au fixture Git :

```ts
// branchWatch est instancié sur le dépôt temporaire après sa préparation.
const snapshot = await branchWatch.capture('main');
expect(snapshot.mergeBaseSha).toBe(commonCommitSha);
expect(snapshot.changes).toContainEqual({ path: 'src/removed.ts', kind: 'deleted' });
expect(snapshot.changes).toContainEqual({ path: 'src/new.ts', kind: 'untracked' });
expect(snapshot.limitations.length).toBeGreaterThan(0);
```

**Vérification :** `rtk npx vitest run tests/analyzer/BranchWatchAnalyzer.test.ts tests/analyzer/ReviewGateAnalyzer.test.ts tests/cli/commands/reviewPr.test.ts`. Attendu : PASS, contrat CLI inchangé. Commit ciblé proposé : `feat: capture branch watch snapshots safely`.

### A2 — Produire des constats honnêtes

**Fichiers :** `BranchWatchAnalyzer.ts`, test associé.

- [ ] Écrire les cas : signature incompatible avec consommateur inchangé ; consommateur modifié ; corps seul modifié ; fichier nouveau ; langage non supporté ; suppression ; index incomplet ; profondeur/fichiers limités.
- [ ] Construire l’impact par fichiers pour tous les langages supportés à partir de `findReferencingFiles`, indépendamment de la présence de symboles dans `ReviewGateResult`. Afficher les dépendants avec leur profondeur et leur présence dans le diff, sans déduire une incompatibilité.
- [ ] Calculer les cycles sur les graphes de référence et courant avec `detectCycleEdges`/`detectCycles` existants ou leur équivalent du graphe de fichiers ; filtrer ensuite par arête ou chemin touché.
- [ ] Classer chaque cycle en `introduced`, `aggravated` ou `existing-touched`, dédupliquer les mêmes cycles malgré un ordre DFS différent et borner le nombre de chemins présentés.
- [ ] Afficher la recommandation “A design change or decomposition is probably required” et l’action d’ouverture du graphe ; ne jamais produire de refactoring automatique ni de statut KO sur ce seul signal.
- [ ] Composer ensuite l’enrichissement de signatures TS/JS avec cet impact ; l’absence de comparaison de signatures Python/Rust/Go/Java/C# ne doit pas supprimer leur graphe d’impact. Conserver la limite de comparaison de contrat.
- [ ] Ajouter des fixtures minimales réelles TypeScript, JavaScript, Python, Rust, C#, Go, Java, Vue, Svelte et GraphQL selon les parsers déjà installés. Chaque entrée est un cas indépendant ; TS ne remplace pas JS et Vue ne remplace pas Svelte. Vérifier un import connu, un dépendant, un fichier isolé, un cycle et une résolution incomplète ; aucune nouvelle grammaire pour cette feature.
- [ ] Pour chaque fixture où le parser expose des relations, couvrir aucun cycle, cycle préexistant non touché, cycle préexistant touché et cycle introduit. Pour les cas sans relation exploitable, vérifier “Cycle cannot be determined” et la limite explicite.
- [ ] Tests Node unitaires avec provider simulé + tests d’intégration des fixtures avec les parsers existants : distinguer erreur de parsing, zéro dépendant connu et langage non pris en charge.
- [ ] Afficher le rappel de réussite attendue des tests sans calculer de statut de test. Conserver seulement les liens statiques déjà disponibles ; ne pas ajouter de détection par conventions de noms.
- [ ] Conserver les constats et leurs sources ; dédupliquer par fichier/symbole/nature. Les limites restent séparées et visibles.
- [ ] Ne pas produire de statut “tested”, de couverture ou d’association de test dans la vue ; afficher uniquement le rappel global “Tests must pass before delivery.”
- [ ] Pour une suppression/renommage, afficher l’événement même si le moteur ne peut plus retrouver ses anciens consommateurs. Ne pas prétendre analyser le graphe historique dans A.
- [ ] Tester qu’un score faible ou une liste de symboles vide ne supprime pas les limites de l’inventaire.

**Vérification :** `rtk npx vitest run tests/analyzer/BranchWatchAnalyzer.test.ts`. Attendu : PASS pour branches actives et partielles. Commit : `feat: report branch vigilance with explicit limitations`.

### A3 — Actualiser sans ralentir ni publier du périmé

**Créer :** `BranchWatchService.ts` et test. **Modifier au minimum :** `GraphProvider.ts`, `extension.ts`, test GraphProvider si point de synchronisation ajouté.

- [ ] Écrire des tests fake timers et promesses contrôlées : 20 événements regroupés en une analyse ; événement pendant analyse → une seule relance ; disable/dispose/pause pendant analyse → aucune publication tardive ; branche/base changée → résultat précédent rejeté.
- [ ] S’abonner seulement quand enabled + workspace trusted + racine Git compatible : événements Git de ce dépôt, sauvegardes/créations/suppressions/renommages pertinents, événements d’actualisation de l’index existant. Sur workspace non Git, conserver uniquement l’écoute légère de changement de configuration/racine nécessaire au bouton Retry.
- [ ] Sur saisie dans un buffer pertinent, marquer dirty immédiatement sans lancer d’analyse ni hasher le contenu à chaque frappe. La sauvegarde déclenche le debounce.
- [ ] Maintenir un compteur de génération global, un timer, un flag inFlight et un flag pending. Ne pas détourner `FileChangeScheduler`, qui est par fichier.
- [ ] Avant exécution : capturer, attendre `prepareIndex`, analyser ; avant publication : vérifier génération, racine, référence, dirty buffers et empreinte. Toute différence déclenche une relance regroupée.
- [ ] Après checkout/rebase/changement HEAD, demander la remise à jour existante de l’index avant revue. Si cela n’est pas possible, rester non vérifié ; réutiliser un index ready de l’ancienne branche est interdit.
- [ ] Les états Git sans changement d’empreinte n’entraînent pas de nouvelle revue. Observer aussi déplacements de référence même sans changement de HEAD.
- [ ] Pause : retirer événements de travail/timers, invalider génération ; reprise : nouvelle capture complète. Disable/dispose : supprimer listeners/status et empêcher toute action tardive. La tâche déjà commencée est annulée si l’API le permet, sinon son résultat est ignoré.
- [ ] Pas de spinner de travail infini si Git ou l’index échoue : état indisponible avec raison et reprise manuelle. Pas de notification répétitive.

Pseudo-code de l’invariant de publication à transformer en test :

```ts
const startedGeneration = generation;
const before = await analyzer.capture(baseRef);
await prepareIndex(before.changes.map(change => change.path));
const result = await analyzer.analyze(before);
const after = await analyzer.capture(baseRef);
if (startedGeneration !== generation || before.fingerprint !== after.fingerprint) {
  // Ne pas publier ; programmer au plus une nouvelle exécution.
  return;
}
// Publier seulement si enabled, non paused, non dirty et racine toujours identique.
```

**Vérification :** `rtk npx vitest run tests/extension/services/BranchWatchService.test.ts tests/extension/GraphProvider.test.ts tests/extension/services/FileChangeScheduler.test.ts`. Commit : `feat: refresh branch watch after workspace changes`.

### A4 — Ajouter une interface native discrète

**Créer :** `BranchWatchTreeProvider.ts`, test associé. **Modifier :** `package.json`, `extension.ts`, `BranchWatchService.ts`.

- [ ] Tests de projection : disabled, paused, dirty, pending, running, unavailable, ready partiel, ready sans changement ; vérifier texte + icône et absence d’OK global et présence d’OK structurel uniquement sans alerte ni limite.
- [ ] Déclarer la Tree View `graph-it-live.branchWatchView` dans `graph-it-live-explorer`, ses settings et son `viewsWelcome`.
- [ ] Déclarer les commandes `graph-it-live.branchWatch.enable`, `.disable`, `.pause`, `.resume`, `.refresh`, `.selectBase`, `.reveal` et `.openFile`. Elles servent aux boutons ; aucune saisie de commande nécessaire dans le parcours normal.
 - [ ] Afficher l’accueil d’activation dans la vue et un accès depuis la toolbar Graph-It-Live, même si la vue de suivi est masquée par un contexte. Après activation, le statut focalise cette vue. Vérifier que chaque chaîne ajoutée est en anglais.
- [ ] Brancher les actions de toolbar via `view/title` et context keys, sans modifier le DOM de la webview. Pause/resume mutuellement exclusives.
- [ ] Choisir la référence parmi les références Git existantes, sauvegarder au scope WorkspaceFolder. Annulation laisse la feature “Select a base reference”, sans analyse.
- [ ] Afficher référence/racine/heure/limites ; un résultat stale reste consultable mais ne conserve jamais son apparence de résultat actuel.
- [ ] Navigation par Uri.file validé et commandes existantes ; labels en texte brut, aucun Markdown trusted issu du code. Cas supprimé : expliquer l’absence, pas ouvrir silencieusement une autre source.
- [ ] Tout nouvel abonnement/item/provider est disposable. Feature disabled : seul accueil inactif, aucun StatusBarItem visible.

**Vérification :** `rtk npx vitest run tests/extension/services/BranchWatchTreeProvider.test.ts tests/extension/services/BranchWatchService.test.ts`. Tests Electron à A5. Commit : `feat: show branch vigilance in a native IDE view`.

### A5 — Vérifier UX, performance et non-régression

**Créer :** `tests/vscode-e2e/suite/branchWatch.test.ts`, `tests/vscode-e2e/suite/branchWatchLanguages.test.ts`, `tests/vscode-e2e/fixtures/branchWatch.fixture.ts` et `tests/cli/reviewPr.e2e.test.ts`. **Modifier :** `tests/cli/commands/reviewPr.test.ts`, `tests/analyzer/ReviewGateAnalyzer.test.ts`, README et DEVELOPMENT. Utiliser le fixture builder pour créer les dépôts temporaires hors des sources analysées du projet ; aucun compilateur/SDK de chaque langage n’est nécessaire à la validation statique.

#### E2E VS Code obligatoires — fonctionnement réel de l’extension

Les tests Electron chargent la vraie extension, le vrai Git et les parsers/index réels. Ne pas remplacer le moteur par un mock dans cette suite. Les mocks restent réservés aux tests unitaires des erreurs difficiles à provoquer.

- [ ] Vérifier que les nouveaux tests sont compilés et découverts par `tests/vscode-e2e/suite/index.ts` (glob des `.test.js`) ; vérifier leur présence dans le rapport, pas seulement le code retour de la suite.
- [ ] Préparer pour chaque fixture Git un dépôt temporaire avec `main`, une branche feature et un commit commun ; activer le suivi par l’action correspondant au bouton de la vue, définir la référence puis modifier/sauvegarder un document via `vscode.workspace.openTextDocument`, `WorkspaceEdit` et `document.save()`.
- [ ] Ne pas mélanger le dossier sans Git au workspace E2E courant : `tests/vscode-e2e/runTests.ts` lance aujourd’hui tous les tests sur `tests/fixtures`, qui est lui-même sous Git. Ajouter un second lancement Electron avec `E2E_WORKSPACE_ROOT` (ou un runner dédié) pointant vers une copie temporaire hors `.git`, puis exécuter uniquement le scénario `noGit`. Un simple sous-dossier de la fixture actuelle ne prouve pas l’absence de dépôt parent.
- [ ] Conserver les suites E2E existantes sur leur workspace Git et vérifier qu’elles ne voient ni settings activés ni statut de branch watch par défaut. Le scénario no-Git doit être isolé par processus pour ne pas contaminer l’état de configuration ou les caches.
- [ ] Attendre une condition observable bornée sur la nouvelle génération du résultat, jamais un simple sleep fixe. Vérifier la référence, la fraîcheur, le fichier modifié, son consommateur attendu et le libellé d’analyse disponible.
- [ ] L’extension testée doit exposer au harness uniquement un instantané en lecture du modèle effectivement rendu, via le mécanisme de test existant ou un hook réservé à ExtensionMode.Test. Ne pas recalculer les résultats dans le test. Vérifier les TreeItems et l’état du StatusBarItem issus de ce même modèle.
- [ ] Invoquer l’action de navigation du TreeItem et vérifier `window.activeTextEditor.document.uri`, puis l’ouverture du graphe pour les langages compatibles. Un test de commande seul ne prouve pas la présence du bouton : vérifier aussi les contributions de toolbar, welcome et leurs conditions de visibilité ; compléter par contrôle UI réel.
- [ ] Vérifier dans un second lancement/reload que enabled/baseRef persistent et que la pause de session ne persiste pas.
- [ ] Exécuter la matrice aussi sur le VSIX packagé pour détecter les parsers/queries absents du package.

#### Matrice multilangage — aucun langage regroupé implicitement

Chaque ligne exige : (1) test d’intégration analyzer sur fichiers réels ; (2) test Electron de sauvegarde → actualisation → résultat → ouverture du consommateur ; (3) contrôle explicite de la limite de comparaison de signatures lorsqu’elle manque. Les fixtures utilisent une syntaxe minimale déjà supportée par le parser, pas une relation supposée à partir d’une convention de nommage.

| Cas indépendant | Fixture minimale | Assertion distinctive |
| --- | --- | --- |
| TypeScript | Module exporté + import consommateur | Impact + changement de signature détecté ; inclure une variante TSX |
| JavaScript | Module exporté + import consommateur | Impact + changement de paramètre détectable ; variantes JSX et modules CJS/MJS selon couverture existante |
| Python | Fonction dans module + import depuis un autre module | Impact visible sans prétendre comparer les signatures Python |
| Rust | Module déclaré/utilisé depuis un consommateur | Impact visible ; test embarqué non assimilé automatiquement à une exécution |
| C# | Relation inter-fichiers résolue par le parser existant | Impact + ouverture du call graph sans passer par Symbol View |
| Go | Import entre packages locaux avec go.mod minimal | Impact + call graph disponible ; les fichiers `_test.go` ne changent pas le statut de la vue |
| Java | Import/référence inter-classes résolue | Impact + call graph sans dépendance à Symbol View |
| Vue | SFC et module importé | Chemin `.vue` réellement traité et navigation correcte |
| Svelte | Composant et module importé | Chemin `.svelte` réellement traité, indépendamment du cas Vue |
| GraphQL | Relation de fichiers reconnue par le résolveur existant | Impact fichier si résolu ; aucune action call graph/schéma incompatible inventée |

- [ ] Pour chaque ligne, vérifier aussi un fichier sans dépendant connu, une suppression et un fichier nouvellement ajouté. Un zéro dépendant connu n’est pas une preuve d’absence d’impact.
- [ ] Pour chaque langage de code, ajouter une modification de corps sans changement de signature : le fichier doit rester présent dans la vue ; aucune rupture de contrat inventée. Pour GraphQL, utiliser une modification de définition.
- [ ] Couvrir cycles, profondeur bornée et relations non résolues dans la matrice d’intégration ; au moins un E2E doit vérifier la présentation de chaque limite.
- [ ] Si une relation annoncée ne peut pas être résolue par le moteur, faire échouer le cas d’acceptation correspondant et décider explicitement de corriger la résolution ou de restreindre/documenter cette capacité. Un skip ou un remplacement silencieux par “unavailable” ne valide pas un support annoncé.
- [ ] Ajouter un monorepo mixte TS + Python + Go : une sauvegarde Python doit apparaître même si aucun symbole TS ne change ; le rappel relatif aux tests reste purement informatif, sans statut de réussite inventé pour aucun composant.
- [ ] Ajouter un fichier de langage non pris en charge : inventaire et limite visibles, pas de résultat sain inventé. Le rapport final liste séparément PASS/FAIL pour les dix lignes.

#### Contrat de non-régression CLI `review-pr`

Le CLI reste une entrée autonome. Le socle multilangage du suivi ne doit ni remplacer son contrat historique ni imposer un runtime VS Code. Enrichir le CLI uniquement si une capacité partagée le nécessite ; ajouter alors des champs optionnels/sections identifiées et leurs tests, sans renommer/supprimer les champs existants ni modifier silencieusement leur sens.

- [ ] Avant modification du moteur partagé, enregistrer des résultats de référence déterministes sur de petits dépôts fixtures : champs JSON, risque/score, ordre des symboles, limites et codes retour. Normaliser seulement chemins temporaires et valeurs volatiles ; pas les preuves ou scores.
- [ ] Étendre `tests/cli/commands/reviewPr.test.ts` pour couvrir les options existantes et les formats actuellement documentés. Vérifier JSON parseable, champs TOON et sections Markdown/text ; pas de logs de suivi polluant stdout.
- [ ] Dans `tests/cli/reviewPr.e2e.test.ts`, lancer le vrai point d’entrée CLI construit, via un processus Node sans VS Code, dans un dépôt temporaire. Respecter les conventions des E2E CLI existants pour build et cwd.
- [ ] Couvrir `--base` sans `--head` : working tree avec commits de branche, staged et unstaged ; préserver la sémantique existante. Le calcul merge-base automatique du suivi IDE ne doit pas être imposé au CLI.
- [ ] Couvrir `--base` + `--head` explicite : comparaison des refs documentée, indépendante des modifications locales. Ajouter une branche de base ayant avancé et une branche divergente pour détecter tout changement de sémantique.
- [ ] Couvrir absence de diff, signature compatible/incompatible, consommateurs modifiés/inchangés, test candidat, langage non supporté, suppressions/renommages selon contrat documenté, limites `--depth`/`--max-files`, ref invalide et option invalide.
- [ ] Couvrir noms avec espaces et caractères spéciaux après passage au parsing NUL. Vérifier les comportements attendus plutôt que figer un ancien bug de parsing.
- [ ] Vérifier qu’un risque élevé seul ne change pas le code retour historique ; les refs/options invalides doivent rester en erreur. Les statuts IDE OK/WARNING/KO ne remplacent pas les niveaux de risque du CLI.
- [ ] Exécuter le CLI avec settings IDE absents, puis enabled/disabled/pause enregistrés : mêmes résultats pour le même dépôt. Aucun import `vscode`, aucun démarrage de watcher IDE.
- [ ] Tout enrichissement nécessaire du CLI dispose d’un cas de test positif et d’un cas montrant que l’ancien consommateur de JSON/TOON retrouve les mêmes champs et types. Adapter `docs/CLI.md` si le comportement visible évolue.
- [ ] Maintenir aussi les tests MCP existants de `review_pr` lorsque le moteur partagé est touché ; aucune régression reportée sur cette autre entrée.

#### Parcours transverses et validation finale

- [ ] E2E dans dépôt Git fixture : activation par bouton, référence persistée, sauvegarde avec modification de signature, statut mis à jour, clic consommateur et graphe, pause/reprise, disable.
- [ ] E2E : annulation de référence, branche changée pendant analyse, root supprimée, buffer dirty, dossier sans Git, Git indisponible, Git sans commit, index indisponible et workspace non trusted. Vérifier l’anglais de tous les messages et l’absence d’analyse de branche dans chaque état indisponible.
- [ ] Vérifier explicitement qu’aucun panneau ne s’ouvre seul et que l’extension désactivée ne lance pas d’analyse de suivi.
- [ ] Vérifier les fonctionnalités antérieures : graphe, sauvegardes, outils LM, CLI/MCP, review-pr. Utiliser les tests existants pertinents, ne pas écrire de doubles de l’implémentation.
- [ ] Mesurer référence feature off/on sur le dépôt courant et un dépôt plus gros disponible : nombre d’analyses, latence après sauvegarde hors debounce, mémoire après 20 cycles enable/disable, réactivité pendant frappe.
- [ ] Cibles proposées, non mesurées : zéro revue au repos ; une revue pour une rafale de sauvegardes ; aucune concurrence ; résultat chaud p95 ≤2 s hors debounce sur le dépôt de référence. Si non atteint, documenter les chiffres et corriger les rescans inutiles avant d’ajouter un worker.
- [ ] Tester manuellement dans Cursor : activation, Git API, toolbar, statut, fichiers, graphe. Mentionner version exacte testée ; ne pas déduire la compatibilité du seul succès VS Code Electron.
- [ ] Documenter le socle multilangage, la comparaison de signatures limitée à TS/JS, la sémantique merge-base, le contenu disque, la référence sans fetch, les limites et le caractère informatif du rappel concernant les tests.

Commandes de validation après modifications source :

```bash
rtk npx vitest run tests/analyzer/BranchWatchAnalyzer.test.ts tests/analyzer/ReviewGateAnalyzer.test.ts tests/extension/services/BranchWatchService.test.ts tests/extension/services/BranchWatchTreeProvider.test.ts
rtk npm run lint
rtk npm run check:types
rtk npm run test:coverage
rtk npx vitest run tests/cli/commands/reviewPr.test.ts tests/cli/reviewPr.e2e.test.ts
rtk npm run test:vscode
rtk proxy graph-it scan
```

Exécuter SonarQube et diagnostics configurés sur les fichiers modifiés ; si l’outil manque, le signaler sans prétendre qu’il a passé. Les contributions au manifeste doivent être vérifiées dans le VSIX : `rtk npm run package`, `rtk npm run package:verify`, puis validation effective de l’inventaire (zéro `.map`, WASM/query assets présents) et `rtk npm run test:vscode:vsix`. Le script package:verify seul n’est pas une preuve de tous les assets. Suivre `.claude/rules/build-packaging.md`.

**Sortie :** A exploitable de façon autonome, limites visibles ; aucune promesse “tested”. Commit : `test: validate branch watch lifecycle and document limits`.

#### Mise à jour architecture et codemaps

- [ ] Après stabilisation des fichiers touchés, exécuter `rtk proxy graph-it architecture --format toon` et comparer le snapshot à l’architecture précédente ; ne pas remplacer un codemap si la variation dépasse 30 % sans accord explicite.
- [ ] Mettre à jour les documents d’architecture réellement concernés, au minimum `docs/architecture/codemaps/architecture.md` (nouveau flux extension → branch watch → analyzer) et `docs/architecture/codemaps/cli.md` uniquement si le contrat ou le rôle de `review-pr` évolue. Mettre à jour `docs/architecture/codemaps/data.md` si les nouveaux types ou états deviennent une donnée partagée ; sinon documenter pourquoi il reste inchangé.
- [ ] Mettre à jour le diagramme d’architecture source approprié (`docs/architecture/graph-it-live-architecture.svg` et sa source HTML/Mermaid si elle existe) seulement si la relation entre composants change ; ne pas éditer une image générée à la main sans régénérer sa source.
- [ ] Ajouter la date de fraîcheur et un rapport de diff structurel sous `.reports/`, conserver les chemins relatifs et vérifier les liens Markdown. Le codemap doit décrire le flux et les interfaces, pas recopier l’implémentation.
- [ ] Vérifier que les codemaps n’introduisent aucune chaîne française dans les sorties produit et qu’ils ne prétendent pas intégrer les résultats de tests utilisateur.

## Risques et décisions de reprise

| Risque | Réponse prévue |
| --- | --- |
| Bruit dû aux heuristiques | Libellés prudents, regroupement par symbole, limites séparées ; aucun KO sur simple score |
| Suppression ou renommage invisible | Inventaire complet indépendant du filtre historique ; WARNING explicite tant que l’impact historique n’est pas analysé |
| Faux OK avec changement de corps | Pas d’OK global en A ; comportement non vérifié conservé |
| Résultats d’une ancienne branche | Génération + SHA + empreinte + synchronisation index avant publication |
| Charges CPU malgré async | Mesurer l’extension host ; borner le travail. Async ne rend pas l’analyse CPU gratuite |
| Index initialisé uniquement avec la vue | A0 doit résoudre l’initialisation sans ouverture forcée du graphe |
| API Git/Cursor indisponible | Indisponibilité claire ; pas de nouveau système de surveillance en fallback automatique |
| Multiplication de fichiers/services | Deux services extension et un module analyzer suffisent ; pas de bus, framework ou nouveau cache persistant |
| Confusion sur les tests | Rappel de réussite attendue uniquement ; aucune collecte, exécution ni validation par le plugin |

Estimations indicatives après lecture, pas engagements : A0–A2 2–4 jours ; A3 2–3 jours ; A4–A5 2–4 jours . L’estimation initiale A de 6–11 jours portait sur le plan centré signatures ; elle ne couvre pas la validation multilangage ajoutée. Réestimer A après A0 et les premiers essais des fixtures, sans promettre la parité pour le même coût. L’indexation sans webview et les cas Git peuvent modifier cette estimation.

## Critères de fin et reprise future

- [ ] Activation sans palette de commandes ; aucun coût d’analyse quand désactivé.
- [ ] Référence persistée et visible ; commits de branche + état local final comparés au merge-base.
- [ ] Impact par fichiers utilisable sur les langages supportés, même sans comparateur de signatures ; les dix cas indépendants ont leurs tests analyzer et Electron passants, y compris dans le package VSIX. Aucun skip ne vaut validation.
- [ ] `review-pr` conserve ses options, sémantique de comparaison, champs existants, scores et codes retour ; enrichissements éventuels additifs documentés et tests CLI réels passants.
- [ ] Changements, suppressions et limites visibles ; pas de promesse “all bugs detected”.
- [ ] Mise à jour automatique, single-flight, résultat périmé jamais affiché courant.
- [ ] Navigation utile et aucun nouveau panneau automatique.
- [ ] Rappel “Tests must pass before delivery” visible ; aucun runner, rapport ou statut de réussite des tests intégré.
- [ ] Qualité, coverage, E2E, package et compatibilité Cursor documentés avec résultats réels.
- [ ] Documents d’architecture et codemaps impactés mis à jour, datés, liés et cohérents avec le flux final ; snapshot `graph-it architecture --format toon` et diff structurel conservés sous `.reports/`.

Prompt de reprise :

> Lis `docs/superpowers/plans/2026-09-16-branch-watch.md` et les règles AGENTS applicables. Vérifie les hypothèses A0 sur l’état actuel du dépôt. Travaille sur la branche `feat/branch-watch`. Implémente la livraison A multilangage tâche par tâche avec `executing-plans`, en préservant les modifications utilisateur et sans intégrer l’exécution ou la validation des tests utilisateur. Les choix proposés sont à confirmer si le contexte produit a changé. Ne présente jamais une association de test comme une preuve d’exécution.

## Sources et validation du présent plan

Sources techniques : [API VS Code stable](https://code.visualstudio.com/api/references/vscode-api), [Tree View](https://code.visualstudio.com/api/extension-guides/tree-view), [Workspace Trust](https://code.visualstudio.com/api/extension-guides/workspace-trust), [API de l’extension Git](https://raw.githubusercontent.com/microsoft/vscode/main/extensions/git/src/api/git.d.ts), [Git diff](https://git-scm.com/docs/git-diff), [Git merge-base](https://git-scm.com/docs/git-merge-base), [Git rev-parse](https://git-scm.com/docs/git-rev-parse). Documentation Git et VS Code consultée via Context7 ; vérifier à nouveau les API au démarrage de l’implémentation.

Validation de cette préparation : lecture ciblée du code et des tests existants, inspection des API officielles, revue de cohérence du plan. Aucun test de la feature n’a été exécuté : les tests et les nouveaux fichiers mentionnés sont des travaux à réaliser.
