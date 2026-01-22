# Graph-It-Live Coding Standards

Ensemble complet des meilleures pratiques de développement pour maintenir la cohérence, la qualité et la maintenabilité du projet Graph-It-Live.

## 🏗️ Architecture & Module Organization

### Layer Separation

Le projet suit une architecture **quatre couches** stricte :

- **`src/analyzer/`** : Analyse des dépendances (Node.js pur, **AUCUNE importation vscode**)
  - Analyse syntaxique AST via ts-morph et tree-sitter
  - Cache, indexation, résolution de chemins
  - Types et utilitaires purs

- **`src/extension/`** : Hôte d'extension VS Code
  - Services d'orchestration dans `extension/services/`
  - Gestion des fichiers, commandes, éditeur
  - Communication avec la webview

- **`src/mcp/`** : Serveur MCP pour LLM/AI (Node.js pur, **AUCUNE importation vscode**)
  - Processus indépendant avec transport stdio
  - 17+ outils d'analyse des dépendances
  - Validation Zod

- **`src/shared/`** : Types et utilitaires partagés
  - Types de messages extension ↔ webview
  - Constantes, utilitaires, logger
  - Protocoles de communication

- **`src/webview/`** : Interface React + ReactFlow
  - Composants React (contexte navigateur)
  - Visualisation des graphes de dépendances
  - Communication typée via le protocole partagé

### Rule Stricte

- ⚠️ **JAMAIS** importer `vscode` dans `analyzer/` ou `mcp/`
- ⚠️ **JAMAIS** importer `node` (fs, path bruts) dans `webview/`
- ✅ Toujours utiliser les utilitaires `src/shared/` pour les chemins

---

## 🌐 Cross-Platform Compatibility (OBLIGATOIRE)

Tous les chemins et opérations doivent fonctionner sur Windows, Linux et macOS.

### Règles de Chemins

```typescript
// ❌ INTERDIT
const path = `/home/user/file.ts`;           // Hardcoded Unix path
const path = `C:\\Users\\user\\file.ts`;     // Hardcoded Windows path
if (filePath.includes("\\")) { ... }          // Assuming backslashes

// ✅ BON
import path from "node:path";
import { normalizePath } from "@/shared/path";

const fullPath = path.join(baseDir, "src", "file.ts");
const normalized = normalizePath(filePath);   // Converts \ to /, lowercase drive
if (normalized.includes("\\")) { ... }        // Checks for escaped backslashes

// ✅ Pour les literal Windows paths en tests
const winPath = String.raw`C:\Users\user\project\file.ts`;
```

### Fonctions Essentielles

- `path.join()` : Jointure sécurisée de chemins
- `path.resolve()` : Chemins absolus
- `normalizePath(path)` de `@/shared/path` : Normalise avant Set/Map
- `String.raw` : Template literals avec backslashes littéraux en tests

### Considérations Filesystem

- ❌ Jamais supposer que le filesystem est sensible à la casse (Windows ne l'est pas)
- ✅ Normaliser avant stockage dans Set/Map: `set.add(normalizePath(path))`
- ✅ Tester les cas Windows dans les tests cross-platform

---

## 🧪 Testing Guidelines

### Principes

- **Unit tests** : Logique métier, mocks pour dépendances externes
- **E2E tests** : Intégration complète VS Code (90+ tests couvrant 95% des features)
- **Cross-Platform** : Tous les tests doivent passer sur Windows, Linux, macOS

### Conventions de Nommage

- `*.test.ts` : Fichiers de test (vitest)
- `*.test.tsx` : Tests composants React
- `tests/fixtures/` : Données de test

### Assertion Patterns

```typescript
// ✅ BON
import { describe, expect, it, vi, beforeEach } from "vitest";

describe("ComponentName", () => {
  let mockCallback: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockCallback = vi.fn();
  });

  it("should do something when condition is met", () => {
    expect(result).toBe(expected);
  });
});

// ❌ ÉVITER
describe("ComponentName", () => {
  const mockCallback = vi.fn(); // Pas de reset entre tests
});
```

### E2E Tests Obligatoires

Ajouter un test e2e pour **CHAQUE** nouvelle feature utilisateur :

- Commandes VS Code
- Paramètres de configuration
- Interactions d'interface
- Support multi-langage (TS/JS/Python/Rust/GraphQL)

---

## 📘 TypeScript Strict Mode

### Configuration

- `tsconfig.json` : `strict: true`, `noImplicitAny: true`, `noUnusedLocals: true`
- ❌ Jamais utiliser `any`
- ✅ Toujours typer explicitement

### Patterns Courants

```typescript
// ❌ MAUVAIS - Type any implicite
function parseData(input) {
  return JSON.parse(input);
}

// ✅ BON - Types explicites
function parseData(input: string): Record<string, unknown> {
  return JSON.parse(input) as Record<string, unknown>;
}

// ❌ MAUVAIS - Variable non utilisée
function process(data: Data, options?: Options) {
  processData(data); // options non utilisé
}

// ✅ BON - Enlever les variables non utilisées
function process(data: Data) {
  processData(data);
}
```

### Type Casts

Utiliser le cast de type explicite quand nécessaire :

```typescript
// ✅ BON
const result = analysisOutput as AnalyzeFileLogicResult;
const nodeData = (node.data as any).label; // Type narrowing
```

---

## ⚛️ React Best Practices

### Dependencies en useMemo/useCallback

⚠️ **RÈGLE CRITIQUE** : Ne JAMAIS inclure de callback props dans les dépendances

```typescript
// ❌ INTERDIT - Causes boucles de re-render
const graph = useMemo(() => {
  return buildGraph({ data, callbacks: { onDrillDown } });
}, [data, onDrillDown]); // onDrillDown change à chaque render!

// ✅ CORRECT - Utiliser useRef pour callbacks
const callbacksRef = useRef({ onDrillDown });
callbacksRef.current = { onDrillDown };

const graph = useMemo(() => {
  return buildGraph({ data, callbacks: callbacksRef.current });
}, [data]); // Pas de callbacks dans deps
```

### Set/Map Direct

```typescript
// ✅ CORRECT - Sets/Maps comparés par référence
const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());
const expanded = useMemo(() => {
  return filterGraph(graph, expandedNodes);
}, [graph, expandedNodes]); // Set par référence OK
```

### Pattern d'useEffect pour Reset

```typescript
// ✅ CORRECT - Dépend UNIQUEMENT de tokens de reset
useEffect(() => {
  expandAllRef.current = false;
  resetTokenRef.current = undefined;
}, [expandAll, resetToken, currentFilePath]);
```

---

## 🧹 Code Quality & Linting

### ESLint Configuration

- Source de vérité : `eslint.config.mjs`
- Exécuter : `npm run lint` avant PR
- Fixer automatiquement : `npm run lint:fix`

### Conventions de Nommage

- Imports : `camelCase` ou `PascalCase` (enforced by ESLint)
- Variables : `camelCase`
- Classes/Types : `PascalCase`
- Constantes : `UPPER_SNAKE_CASE`

```typescript
// ✅ BON
import { FileReader, cacheSize } from "@/analyzer";
class DependencyAnalyzer {}
const MAX_DEPTH = 10;
let currentFile: string;

// ❌ MAUVAIS
import { file_reader, CacheSize } from "@/analyzer";
class dependency_analyzer {}
const maxDepth = 10;
let CURRENT_FILE: string;
```

### Path Alias

Utiliser `@/` pour les imports `src/` quand cela améliore la clarté :

```typescript
// ✅ PRÉFÉRÉ
import { Spider } from "@/analyzer/Spider";
import { normalizePath } from "@/shared/path";

// ✅ AUSSI BON
import { buildGraph } from "../utils/buildGraph";
```

---

## 🔒 SonarQube Compliance

### Règles Clés à Respecter

| Règle     | Pattern                        | Fix                            |
| --------- | ------------------------------ | ------------------------------ |
| **S7780** | `"C:\\path"` sans String.raw   | `String.raw`C:\path``          |
| **S1845** | `.replace(/pattern/g, ...)`    | `.replaceAll(old, new)`        |
| **S3776** | Complexité cognitive > 15      | Refactoriser en fonctions      |
| **S1542** | Fonctions sans `return` unique | Ajouter return/else            |
| **S2715** | Valeurs magiques               | Extraire en constantes nommées |

### Scanning

```bash
# Analyser un fichier
npx sonarqube analyze-file src/analyzer/Spider.ts

# Ou dans VS Code: Tools > SonarQube > Analyze Current File
```

---

## 📦 VS Code Extension Packaging

### ⚠️ Règles CRITIQUES

**ZÉRO fichier source map (.map) autorisé dans le package .vsix**

```bash
# Build production
npm run build -- --production

# Package l'extension
npm run package

# VÉRIFIER (OBLIGATOIRE)
npx vsce ls | grep "\.map$"  # Doit être vide!

# Ou utiliser le script npm
npm run package:verify       # ✅ Préféré
```

### Dépendances Externes

- ✅ Garder externe : Native binaries (`tree-sitter`, `tree-sitter-python`, `tree-sitter-rust`)
- ❌ Ne JAMAIS externe : Modules JS/TS purs (seront bundlés)

### .vscodeignore Strategy

```
# Top priority: Exclude ALL .map files
**/*.map

# Exclude all node_modules
node_modules/**

# Re-include only required dependencies (specific paths)
!node_modules/tree-sitter/
!node_modules/tree-sitter-python/
!node_modules/node-gyp-build/

# Never use broad re-inclusion
# ❌ !node_modules/package/**  (includes .map files)
```

### Taille du Package

- ✅ Cible : ~16 MB
- ❌ Limiter les dépendances, exclure tests/docs

---

## 📝 Conventions de Commits

### Format Conventional Commits

```
feat: Add symbol-level cycle detection
fix: Handle Windows paths in path resolver
refactor: Extract cache invalidation logic
docs: Update MCP server documentation
test: Add e2e tests for expandAllNodes command
chore: Update dependencies
```

### Pull Request Template

- Résumé court de la feature/fix
- Commandes d'exécution et résultats (ex: `npm test`)
- Screenshots/GIFs pour changements UI
- Lien vers issues/discussions pertinentes

### Avant PR

1. ✅ Tous les tests passent : `npm test`
2. ✅ Pas d'erreurs TS : `npm run check:types`
3. ✅ Pas d'erreurs lint : `npm run lint`
4. ✅ E2E tests pour features utilisateur : `npm run test:vscode:vsix`
5. ✅ Pour changes build config : Package verification ✓

---

## 🛡️ Error Handling

### SpiderError Pattern

```typescript
import { SpiderError, SpiderErrorCode } from "@/analyzer";

try {
  const result = await spider.crawl(entryFile);
} catch (error) {
  if (error instanceof SpiderError) {
    switch (error.code) {
      case SpiderErrorCode.FILE_NOT_FOUND:
        console.error(`File not found: ${error.filePath}`);
        break;
      case SpiderErrorCode.PARSE_ERROR:
        console.error(`Parse error in ${error.filePath}: ${error.message}`);
        break;
      default:
        console.error(`Unknown error: ${error.message}`);
    }
  } else {
    console.error("Unexpected error:", error);
  }
}
```

### Validation & Security

- Utiliser **Zod v4** pour la validation des entrées
- Valider les chemins pour éviter path traversal
- Loguer les erreurs avec contexte

```typescript
import { z } from "zod";

const filePathSchema = z
  .string()
  .min(1, "File path required")
  .refine((p) => !p.includes(".."), "Path traversal not allowed");

const filePath = filePathSchema.parse(userInput);
```

---

## 🔧 MCP Server Patterns

### Tool Description Format

Tous les tools doivent suivre le pattern **WHEN/WHY/WHAT** :

```typescript
{
  name: "graphItLive_analyzeFile",
  description: `
    **WHEN**: When you need to analyze a single file's symbols and dependencies
    **WHY**: AST parsing is required - you cannot do this without running analysis code
    **WHAT**: Returns symbol graph with all imported symbols and their locations
  `,
  inputSchema: { /* Zod schema */ },
}
```

### Tool Naming

- Tous les tools préfixés : `graphItLive_` (ex: `graphItLive_setWorkspace`)
- Camel case après préfixe
- Noms descriptifs et verbes d'action

---

## 🎯 Performance & Optimization

### Debouncing

Utiliser pour les opérations coûteuses (re-indexation, refresh du graphe) :

```typescript
private _debounceTimer?: NodeJS.Timeout;

handleFileChange(filePath: string) {
  if (this._debounceTimer) {
    clearTimeout(this._debounceTimer);
  }
  this._debounceTimer = setTimeout(() => {
    this._reindexFile(filePath);
  }, 500);  // 500ms debounce standard
}
```

### Caching

- Implémenter cache avec invalidation intelligente
- Utiliser `ReverseIndex` pour lazy cleanup (ne pas supprimer immédiatement)
- Voir `src/analyzer/Cache.ts`

### Indexing Concurrency

Configuration : `indexingConcurrency` (1-16, défaut: 4)

- Contrôlé via settings VS Code
- Respecter limite en simultané

---

## 📚 Documentation

### README

- Quick Start clair avec commandes
- Installation et dev workflow
- Architecture overview
- Architecture Diagram

### Code Comments

- Documenter le **POURQUOI**, pas le **QUOI**
- Utiliser JSDoc pour les exports publics

```typescript
/**
 * Analyzes file-level dependencies using regex parsing
 * @param filePath - Absolute path to source file
 * @returns Array of imported module paths
 * @throws {SpiderError} If file cannot be read
 */
export function analyzeFileLevelDeps(filePath: string): string[] {
  // ...
}
```

### Instruction Files

Les règles importantes sont centralisées :

- `.github/instructions/package_validation.instructions.md` : Extension packaging
- `.github/instructions/snyk_rules.instructions.md` : Security scanning
- `.github/instructions/sonarqube_rules.instructions.md` : Code quality
- `.github/copilot-instructions.md` : Dev guide complet

---

## 🔄 Development Workflow

### Setup Initial

```bash
npm install              # Uses --legacy-peer-deps
npm run build           # Bundle via esbuild
npm run watch           # Rebuild on change
npm test                # Run Vitest tests
```

### Development Loop

1. Faire changements en TypeScript
2. `npm run watch` pour rebuild continu
3. Presser F5 dans VS Code pour Extension Development Host
4. Tester dans l'extension en dev
5. `npm test` pour valider
6. `npm run lint` et `npm run check:types`
7. Commiter via Conventional Commits

### Pre-PR Checklist

- [ ] `npm test` - tous tests passent
- [ ] `npm run check:types` - 0 erreurs TS
- [ ] `npm run lint` - 0 erreurs ESLint
- [ ] `npm run test:vscode:vsix` - E2E tests OK
- [ ] SonarQube scan sur fichiers modifiés
- [ ] Documentation/comments à jour
- [ ] Commits bien formatés
- [ ] Si build config changed: Package verification ✓

---

## 🚨 Anti-Patterns à Éviter

| Anti-Pattern                     | Raison                                  | Lieu                 |
| -------------------------------- | --------------------------------------- | -------------------- |
| `any` type                       | Perd la sécurité de type                | Partout              |
| Callback props en deps           | Re-render cascades et corruption d'état | React                |
| `require()` dynamique            | Problèmes de bundling                   | Extension            |
| Hardcoded paths `/` ou `\`       | Incompatibilité cross-platform          | Partout              |
| Skip source map exclusion        | Explose taille du package .vsix         | Extension            |
| Pas de e2e tests pour features   | Regressions non détectées               | Features utilisateur |
| Logique d'analyse dans extension | Couple analyzer à VS Code               | analyzer/, mcp/      |
| Error silent suppression         | Bugs difficiles à déboguer              | Partout              |

---

## 📊 Code Metrics

### Targets

- **Test Coverage** : ~95% des features utilisateur couverts par e2e
- **TypeScript** : 0 erreurs, strict mode
- **ESLint** : 0 erreurs, configurations appliquées
- **SonarQube** : Compliance avec règles du projet
- **Package Size** : ~16 MB for .vsix

---

## ✅ Checklist de Qualité

Avant de soumettre une PR :

- [ ] Code compiles sans erreurs (`npm run check:types`)
- [ ] Tous les tests passent (`npm test`)
- [ ] Pas de lint warnings (`npm run lint`)
- [ ] E2E tests pour nouvelles features utilisateur
- [ ] Package validation si build config changed (`npm run package:verify`)
- [ ] SonarQube scan effectué sur fichiers modifiés
- [ ] Cross-platform paths avec `path.join()` ou `normalizePath()`
- [ ] Pas de `any` types
- [ ] Comments pour logique complexe
- [ ] Commits Conventional Commits formatés
- [ ] Pas de `.map` files dans le package
- [ ] README/docs à jour si feature visible

---

## 📚 Ressources Complémentaires

- **Architecture Détaillée** : Voir `AGENTS.md`
- **MCP Server** : Voir `src/mcp/README.md` (à créer)
- **Testing Cross-Platform** : Voir `docs/CROSS_PLATFORM_TESTING.md`
- **Performance** : Voir `docs/PERFORMANCE_OPTIMIZATIONS.md`
- **Git Workflow** : Conventional Commits style

---

**Maintenu par** : Graph-It-Live Development Team  
**Dernière mise à jour** : Janvier 2026  
**Version du document** : 1.0
