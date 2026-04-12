# C#, Go, Java Language Support

Date: 2026-04-12  
Status: Implemented  
Author: Graph-It-Live team

---

## Summary

Add first-class support for **C# (.cs, .csproj)**, **Go (.go)**, and **Java (.java)** across the two analysis levels of Graph-It-Live:

| Level | What it does | Current languages |
|-------|-------------|-------------------|
| **L1 — File-level** | Import parsing + file-to-file dependency graph | TS/JS, Python, Rust |
| **L2 — Call graph** | Symbol extraction + CALLS/INHERITS/IMPLEMENTS/USES edges via Tree-sitter | TS/JS, Python, Rust |

All three WASM grammars shipped in the existing `tree-sitter-wasms` dependency are already available at `node_modules/tree-sitter-wasms/out/`:
- `tree-sitter-c_sharp.wasm`
- `tree-sitter-go.wasm`
- `tree-sitter-java.wasm`

No new npm dependencies are required.

---

## Goals

- Full L1 + L2 support for `.cs`, `.go`, `.java` files
- Partial L1 support for `.csproj` (C# project references), treated like `Cargo.toml` for Rust
- Language-specific icons and brand colors in all graph views (ReactFlow file graph, Cytoscape call graph)
- Maintain zero breaking changes for existing supported languages
- All new code paths covered by unit tests and e2e smoke tests
- Cross-platform path handling (Windows/Linux/macOS) throughout

## Non-Goals — v1

- `.sln` solution files (complex proprietary format, low ROI; deferred to v2)
- Symbol-level analyzers (`ISymbolAnalyzer`) for C#, Go, Java — L1 file graph and L2 call graph are sufficient for v1; the symbol drilldown view will show an "unsupported language" message gracefully
- `go.mod` deep resolution for multi-module workspaces (best-effort single-module resolution only)
- Maven/Gradle build file parsing for Java (`.pom.xml`, `build.gradle`)

---

## File Type Policy

### C#

| Extension | Status | Analysis |
|-----------|--------|----------|
| `.cs` | **Supported** | L1 + L2 full analysis |
| `.csproj` | **Supported (L1 only)** | Parse `<ProjectReference Include="…"/>` elements → file-level project dependencies |
| `.sln` | **Not supported v1** | Deferred |

**Rationale for `.csproj`**: A C# solution is composed of multiple `.csproj` projects that reference each other via `<ProjectReference>`. Visualising these references is high-value and mirrors how `Cargo.toml` files are treated for Rust workspaces. The WASM tree-sitter C# grammar does not yet handle `.csproj` (XML). Parsing will use a lightweight regex/string approach targeting `<ProjectReference Include="path\to\OtherProject.csproj"/>` lines — consistent with how the TypeScript parser handles `Cargo.toml` entries through the existing import parser interface.

### Go

| Extension | Status | Analysis |
|-----------|--------|----------|
| `.go` | **Supported** | L1 + L2 full analysis |
| `go.mod` | **Not supported v1** | Deferred (discovery utility only, no graph node) |

### Java

| Extension | Status | Analysis |
|-----------|--------|----------|
| `.java` | **Supported** | L1 + L2 full analysis |
| `.class` | **Not supported** | Binary format |

---

## Colors and Visual Identity

### Brand Colors

The following colors will be added to `LANGUAGE_COLORS` in `src/shared/constants.ts`:

| Language | Key | Color | Rationale |
|----------|-----|-------|-----------|
| C# | `csharp` | `#9b4f96` | Microsoft C# purple (VS logo, dotnet.microsoft.com) — Custom SVG |
| Go | `go` | `#00acd7` | Exact color from SuperTinyIcons `go.svg` (`fill="#00acd7"`) — matches go.dev brand |
| Java | `java` | `#f8981d` | Primary orange from SuperTinyIcons `java.svg` (`fill="#f8981d"`) — JCP flame color |

These colors propagate automatically to all three visual systems:

1. **`EXTENSION_COLORS`** (border colors in the ReactFlow file node graph)  
2. **`CytoscapeTheme.ts` `LANG_COLORS`** (node fill in the call graph panel)  
3. **`LanguageIcon.tsx` `LANGUAGE_CONFIGS`** (language icon badge on file nodes)

### C# Project File Color

`.csproj` files use the same `csharp` color as `.cs` files (same language ecosystem).

### SVG Icons

Inline SVG icons added to `SVG_ICONS` in `LanguageIcon.tsx`.  
Source: **SuperTinyIcons** (https://github.com/edent/SuperTinyIcons) — consistent with all existing icons (Python, Rust, Vue, Svelte, GraphQL).

> Note: SuperTinyIcons has `go.svg` and `java.svg` but **no `csharp.svg`**.  
> Go and Java use the upstream icons verbatim. C# uses a custom SVG designed in the same style.

#### Go — `go.svg` from SuperTinyIcons (exact)

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path d="m0 0H512V512H0" fill="#fff"/><path fill="#00acd7" d="M308 220c1 2-1 2-2 2l-34 9c-3 2-5-1-5-1-21-26-65-8-67 30-2 36 45 50 67 14h-38c-3 0-8-1-3-10l8-17c2-4 3-4 9-4h70c0 81-90 117-138 68-22-23-29-75 16-112 36-29 96-29 117 21m16 96c-45-39-21-120 50-133 73-13 105 55 76 106-24 43-88 61-126 27m94-51c9-25-9-49-36-47-30 3-51 42-32 65 19 22 58 12 68-18m-321-2v-1l2-5 2-1h41l1 1-1 5-1 1H97m-48-18s-2 0-1-1l4-6 2-1h92l1 1-2 5-1 1-95 1m30-19-1-1 5-5 2-1h72v1l-3 5-2 1H79"/></svg>
```

> The icon uses `#00acd7` — the official Go blue in the SuperTinyIcons asset.  
> `LANGUAGE_COLORS.go` must be set to `#00acd7` (not `#00add8`) to match the icon exactly.

#### Java — `java.svg` from SuperTinyIcons (exact)

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" fill="none"><path d="m0 0H512V512H0" fill="#fff"/><path d="M274 235c18 21-5 40-5 40s47-24 25-54-35-42 48-90c0-1-131 32-68 104M294 53s40 40-38 100c-62 49-14 77 0 109-36-33-63-61-45-88 27-40 99-59 83-121" fill="#f8981d"/><path d="M206 347s-15 8 10 11 46 3 79-3a137 137 0 0021 10c-74 32-169-1-110-18m-9-42s-16 12 9 15 58 4 102-5a45 45 0 0016 10c-91 26-192 2-127-20m175 73s11 9-12 16c-43 13-179 17-217 1-14-6 15-17 33-17-17-10-98 21-42 30 153 24 278-12 238-30M213 262s-69 16-25 22c19 3 57 2 92-1s57-8 57-8a122 122 0 00-17 9c-70 18-206 10-167-9s60-13 60-13m124 69c73-37 39-80 7-66 36-30 101 36-9 68zM220 432c69 4 174-2 176-35 0 0-5 12-57 22s-131 10-174 3c1 0 10 7 55 10" fill="#5382a1"/></svg>
```

> The Java icon uses two official JCP colors: `#f8981d` (flame orange) and `#5382a1` (platform blue).  
> `LANGUAGE_COLORS.java` must be set to `#f8981d` (primary brand orange, used for node borders and call-graph fills).

#### C# — Custom SVG (SuperTinyIcons has no C# icon)

SuperTinyIcons does not include a C# icon as of April 2026. A custom SVG is created in the **same visual style** (512×512, white background, solid path, single brand color):

- White background: `<path d="m0 0H512V512H0" fill="#fff"/>`
- Brand color: `#9b4f96` (Microsoft C# purple, matching VS title bar and dotnet.microsoft.com)
- Shape: simplified **C + # operator** — a large "C" arc on the left and a compact "#" grid on the right

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path d="m0 0H512V512H0" fill="#fff"/><path fill="#9b4f96" d="M64 256c0-106 86-192 192-192 54 0 103 22 138 58l-45 45c-24-24-57-38-93-38-72 0-130 58-130 127s58 127 130 127c36 0 69-14 93-38l45 45c-35 36-84 58-138 58-106 0-192-86-192-192zm268-80h-30v-52h-30v52h-28v-52h-30v52a14 14 0 000 28h14v56h-14a14 14 0 000 28h30v52h30v-52h28v52h30v-52a14 14 0 000-28h-14v-56h14a14 14 0 000-28z"/></svg>
```

This custom SVG follows the same encoding convention as the TOML icon already in the codebase. If SuperTinyIcons adds a C# icon in the future, replace with the upstream asset.

---

## Architecture Changes

### 1. `src/shared/constants.ts`

```typescript
// New extension constants
export const CSHARP_EXTENSIONS   = ['.cs', '.csproj'] as const;
export const GO_EXTENSIONS        = ['.go'] as const;
export const JAVA_EXTENSIONS      = ['.java'] as const;

// Add to SUPPORTED_FILE_EXTENSIONS spread

// Add to LANGUAGE_COLORS
csharp: '#9b4f96',  // Microsoft C# purple — custom SVG
go:     '#00acd7',  // SuperTinyIcons go.svg exact color
java:   '#f8981d',  // SuperTinyIcons java.svg primary orange

// Add to EXTENSION_COLORS
'.cs':     LANGUAGE_COLORS.csharp,
'.csproj': LANGUAGE_COLORS.csharp,
'.go':     LANGUAGE_COLORS.go,
'.java':   LANGUAGE_COLORS.java,
```

`SUPPORTED_SOURCE_FILE_REGEX` updated:
```typescript
/\.(ts|tsx|js|jsx|vue|svelte|gql|graphql|py|pyi|rs|cs|csproj|go|java)$/
```

`WATCH_GLOB` updated:
```
**/*.{ts,tsx,js,jsx,vue,svelte,gql,graphql,py,pyi,rs,toml,cs,csproj,go,java}
```

### 2. `src/shared/utils/languageDetection.ts`

```typescript
'.cs':     'csharp',
'.csproj': 'csharp',
'.go':     'go',
'.java':   'java',
```

### 3. `src/shared/callgraph-types.ts`

```typescript
export type SupportedLang =
  | "typescript" | "javascript"
  | "python" | "rust"
  | "csharp" | "go" | "java";   // NEW
```

TypeScript's exhaustive switch checking will surface all call sites that need updating.

### 4. `src/analyzer/LanguageService.ts`

New enum values:
```typescript
export enum Language {
  TypeScript = "typescript",
  Python     = "python",
  Rust       = "rust",
  CSharp     = "csharp",   // NEW
  Go         = "go",       // NEW
  Java       = "java",     // NEW
  Unknown    = "unknown",
}
```

`detectLanguage()` — new cases:
```typescript
case ".cs":
case ".csproj":
  return Language.CSharp;
case ".go":
  return Language.Go;
case ".java":
  return Language.Java;
```

New static parser caches and `getAnalyzer()` / `reset()` updated accordingly.

### 5. New Parser Files (`src/analyzer/languages/`)

#### `CSharpParser.ts` — `ILanguageAnalyzer`

**Import syntax to handle:**
```csharp
using System;                          // stdlib → skip
using System.Collections.Generic;     // stdlib → skip
using Microsoft.Extensions.DependencyInjection; // stdlib → skip
using MyProject.Services;             // local namespace → analyze
using MyProject.Utils.StringHelper;   // local namespace → analyze
```

**Strategy:**
1. Use tree-sitter `using_directive` nodes to extract the namespace path
2. Filter out well-known stdlib/framework prefixes: `System`, `Microsoft`, `Newtonsoft`, `NUnit`, `Xunit`, `Moq`
3. Convert namespace path to candidate file paths by mapping `MyProject.Services` → find `.cs` files whose path contains `Services/` segment
4. `resolvePath()`: walk workspace looking for `{LastSegment}.cs` matching the namespace tail

**`.csproj` handling:**
- Use lightweight line-based scan for `<ProjectReference Include="..." />`
- Resolve the `Include` path relative to the `.csproj` file (paths use Windows backslash in project files → normalize)
- Return as `Dependency` objects with `type: "import"`

#### `GoParser.ts` — `ILanguageAnalyzer`

**Import syntax to handle:**
```go
import "fmt"                           // stdlib → skip
import "os"                            // stdlib → skip
import "github.com/user/repo/pkg"     // external module → skip
import "mymodule/internal/services"   // local → analyze
import (
  "mymodule/api"
  "mymodule/utils/converter"
)
```

**Strategy:**
1. Use tree-sitter `import_declaration` / `import_spec` / `interpreted_string_literal` nodes
2. Read `go.mod` in workspace root to obtain module name (e.g. `module mymodule`)
3. Filter: if import path starts with the module name → local; otherwise stdlib/external → skip
4. `resolvePath()`: strip module prefix, convert `/` separators to OS path, look for the directory

**Stdlib detection fallback** (when `go.mod` absent): treat any import without `/` chars as stdlib (e.g. `"fmt"`, `"os"`, `"sync"`).

#### `JavaParser.ts` — `ILanguageAnalyzer`

**Import syntax to handle:**
```java
import java.util.List;              // stdlib → skip
import javax.persistence.*;         // stdlib → skip
import org.springframework.beans.*; // external → skip
import com.mycompany.app.services.UserService; // local → analyze
```

**Strategy:**
1. Use tree-sitter `import_declaration` nodes (child `scoped_identifier`)
2. Filter out well-known stdlib/framework prefixes: `java.`, `javax.`, `org.springframework`, `org.hibernate`, `com.google`, `junit`, `org.junit`, `io.micronaut`
3. Convert `com.mycompany.app.services.UserService` → look for `UserService.java` in any directory matching the `services` path segment
4. `resolvePath()`: best-effort search looking for `{ClassName}.java` under workspace root respecting Maven convention (`src/main/java/`) when present

### 6. `src/analyzer/callgraph/GraphExtractor.ts`

#### `fileExtToLang()` additions:
```typescript
case ".cs":
case ".csproj":  // csproj included for future; produces empty graph if no SCM match
  return "csharp";
case ".go":
  return "go";
case ".java":
  return "java";
```

#### `langToWasmFileName()` additions:
```typescript
case "csharp": return "tree-sitter-c_sharp.wasm";  // NOTE: underscore in WASM filename
case "go":     return "tree-sitter-go.wasm";
case "java":   return "tree-sitter-java.wasm";
```

#### `normalizeQueryLang()`: no sharing — each language has its own `.scm` file.

#### `MEMBER_ACCESS_PARENT_TYPES` additions:
```typescript
"member_access_expression", // C# — obj.Method()
"selector_expression",      // Go  — obj.Method()
"field_access",             // Java — obj.method()
```

### 7. Tree-sitter Query Files (`resources/queries/`)

#### `csharp.scm`

C#-specific node types from the tree-sitter-c-sharp grammar:

```scheme
; DEFINITIONS
(method_declaration name: (identifier) @def.method)
(constructor_declaration name: (identifier) @def.method)
(class_declaration name: (identifier) @def.class)
(interface_declaration name: (identifier) @def.interface)
(struct_declaration name: (identifier) @def.class)
(record_declaration name: (identifier) @def.class)
(enum_declaration name: (identifier) @def.class)
(property_declaration name: (identifier) @def.variable)
(field_declaration (variable_declaration (variable_declarator name: (identifier) @def.variable)))

; CALLS — invocation_expression
(invocation_expression function: (identifier) @call)
(invocation_expression function: (member_access_expression name: (identifier) @call))
(object_creation_expression type: (identifier) @call)
(object_creation_expression type: (generic_name name: (identifier) @call))

; INHERITS — class extends
(base_list (identifier) @inherit)
(base_list (generic_name name: (identifier) @inherit))

; IMPLEMENTS — already captured by @inherit (C# base_list covers both)

; USES — type references
(parameter type: (identifier) @uses)
(parameter type: (generic_name name: (identifier) @uses))
(variable_declaration type: (identifier) @uses)
(variable_declaration type: (generic_name name: (identifier) @uses))
```

#### `go.scm`

Go-specific node types:

```scheme
; DEFINITIONS
(function_declaration name: (identifier) @def.function)
(method_declaration name: (field_identifier) @def.method)
(type_spec name: (type_identifier) @def.class)

; CALLS — call_expression
(call_expression function: (identifier) @call)
(call_expression function: (selector_expression field: (field_identifier) @call))

; INHERITS — Go has no inheritance; embedding via field declarations
; (no @inherit captures — Go uses composition, not inheritance)

; USES — type references in function signatures
(parameter_declaration type: (type_identifier) @uses)
(result_statement (type_identifier) @uses)
(var_declaration (var_spec type: (type_identifier) @uses))
```

#### `java.scm`

Java-specific node types:

```scheme
; DEFINITIONS
(method_declaration name: (identifier) @def.method)
(constructor_declaration name: (identifier) @def.method)
(class_declaration name: (identifier) @def.class)
(interface_declaration name: (identifier) @def.interface)
(enum_declaration name: (identifier) @def.class)
(annotation_type_declaration name: (identifier) @def.interface)

; CALLS
(method_invocation name: (identifier) @call)
(object_creation_expression type: (type_identifier) @call)

; INHERITS — extends
(superclass (type_identifier) @inherit)

; IMPLEMENTS
(super_interfaces (type_list (type_identifier) @impl))

; USES
(formal_parameter type: (type_identifier) @uses)
(local_variable_declaration type: (type_identifier) @uses)
(field_declaration type: (type_identifier) @uses)
```

### 8. `src/extension/services/CallGraphViewService.ts`

#### `toSupportedLang()` additions:
```typescript
case "csharp": return "csharp";
case "go":     return "go";
case "java":   return "java";
```

#### `langFromPath()` additions:
```typescript
if ([".cs"].includes(ext)) return "csharp";  // .csproj excluded from call graph
if (ext === ".go") return "go";
if (ext === ".java") return "java";
```

#### `getQueryFreshnessCutoffs()`: add entries for `csharp`, `go`, `java`.

### 9. `esbuild.js` — `copyWasmFiles()`

```javascript
{ src: 'node_modules/tree-sitter-wasms/out/tree-sitter-c_sharp.wasm', fileName: 'tree-sitter-c_sharp.wasm' },
{ src: 'node_modules/tree-sitter-wasms/out/tree-sitter-go.wasm',      fileName: 'tree-sitter-go.wasm' },
{ src: 'node_modules/tree-sitter-wasms/out/tree-sitter-java.wasm',    fileName: 'tree-sitter-java.wasm' },
```

### 10. Webview

#### `LanguageIcon.tsx`

New entries in `SVG_ICONS`:
```typescript
csharp: '<svg ...>', // C# purple icon
go:     '<svg ...>', // Go blue icon
java:   '<svg ...>', // Java orange icon
```

New entries in `LANGUAGE_CONFIGS`:
```typescript
'.cs':     { id: 'csharp', fallback: 'C#',   color: LANGUAGE_COLORS.csharp, svg: SVG_ICONS.csharp },
'.csproj': { id: 'csharp', fallback: 'proj', color: LANGUAGE_COLORS.csharp, svg: SVG_ICONS.csharp },
'.go':     { id: 'go',     fallback: 'Go',   color: LANGUAGE_COLORS.go,     svg: SVG_ICONS.go     },
'.java':   { id: 'java',   fallback: 'Java', color: LANGUAGE_COLORS.java,   svg: SVG_ICONS.java   },
```

#### `CytoscapeTheme.ts` — `LANG_COLORS`

```typescript
["csharp", LANGUAGE_COLORS.csharp ?? UNKNOWN_COLOR],
["go",     LANGUAGE_COLORS.go     ?? UNKNOWN_COLOR],
["java",   LANGUAGE_COLORS.java   ?? UNKNOWN_COLOR],
```

---

## Test Strategy

### Layer 1 — Unit Tests

#### New test files

| File | Covers |
|------|--------|
| `tests/analyzer/CSharpParser.test.ts` | `using` import parsing, `.csproj` `<ProjectReference>` parsing, stdlib exclusion, path resolution |
| `tests/analyzer/GoParser.test.ts` | `import` parsing (single + block), `go.mod` module discovery, stdlib detection, path resolution |
| `tests/analyzer/JavaParser.test.ts` | `import` parsing (single-type, wildcard, static), stdlib exclusion, Maven layout resolution |
| `tests/analyzer/callgraph/GraphExtractor.csharp.test.ts` | C# `.scm` query captures: methods, classes, invocations, inheritance |
| `tests/analyzer/callgraph/GraphExtractor.go.test.ts` | Go `.scm` query captures: functions, method receivers, call expressions |
| `tests/analyzer/callgraph/GraphExtractor.java.test.ts` | Java `.scm` query captures: methods, classes, extends/implements |

#### Updated test files

| File | Change |
|------|--------|
| `tests/analyzer/LanguageService.test.ts` | Add: detection of `.cs`, `.csproj`, `.go`, `.java`; `getAnalyzer()` returns correct parser class |
| `tests/shared/languageDetection.test.ts` | Add: `detectLanguageFromExtension` for new extensions |
| `tests/analyzer/SourceFileFilters.test.ts` | Add: `isSupportedSourceFile` returns `true` for `.cs`, `.go`, `.java`, `.csproj` |
| `tests/integration/BuildVerification.test.ts` | Add: `dist/wasm/tree-sitter-c_sharp.wasm`, `dist/wasm/tree-sitter-go.wasm`, `dist/wasm/tree-sitter-java.wasm` existence checks |

#### Key unit test cases per parser

**CSharpParser**
```
✓ Extracts local namespace from `using MyProject.Services;`
✓ Skips `using System;`, `using System.Linq;`, `using Microsoft.Extensions.*;`
✓ Skips `using Newtonsoft.Json;`, `using NUnit.Framework;`
✓ Parses <ProjectReference Include="..\..\OtherProject\OtherProject.csproj"/> in .csproj
✓ Normalizes Windows backslash paths in ProjectReference Include attribute
✓ Does not produce duplicates for the same namespace used twice
✓ Returns empty array for a file with only stdlib usings
✓ resolvePath() returns null for unresolvable namespaces
```

**GoParser**
```
✓ Extracts local import from single import `"mymodule/pkg/utils"`
✓ Extracts multiple imports from grouped import block
✓ Skips stdlib: `"fmt"`, `"os"`, `"net/http"`, `"sync/atomic"`
✓ Skips external modules when go.mod present and import doesn't match module name
✓ Falls back to no-slash heuristic when go.mod absent
✓ Handles blank identifier import `_ "mymodule/side/effect"`
✓ Handles aliased import `alias "mymodule/pkg"` → associates module path correctly
```

**JavaParser**
```
✓ Extracts `import com.mycompany.services.UserService;`
✓ Handles wildcard `import com.mycompany.utils.*;` → module = "utils"
✓ Handles static import `import static com.mycompany.Constants.MAX_SIZE;`
✓ Skips `java.util.*`, `javax.servlet.*`, `org.springframework.*`
✓ Skips `org.junit.*`, `com.google.common.*`, `io.micronaut.*`
✓ Does not duplicate when same class imported twice (edge case)
✓ resolvePath() uses Maven layout `src/main/java/` when present
```

### Layer 2 — Test Fixtures

Create representative mini-projects under `tests/fixtures/`:

#### `tests/fixtures/csharp-integration/`
```
Program.cs               ← entry point: using MyProject.Services; using MyProject.Utils;
MyProject.csproj         ← <ProjectReference Include="../other-project/OtherProject.csproj"/>
Models/User.cs           ← class User { ... }
Services/UserService.cs  ← using MyProject.Models; public class UserService { ... }
Utils/StringHelper.cs    ← public static class StringHelper { ... }
```

#### `tests/fixtures/go-integration/`
```
go.mod                   ← module mymodule/v2
main.go                  ← import "mymodule/v2/services"; import "fmt"
services/user.go         ← package services; import "mymodule/v2/models"
models/user.go           ← package models; type User struct { ... }
```

#### `tests/fixtures/java-integration/`
```
src/main/java/com/example/app/
  Main.java              ← import com.example.app.services.UserService; class Main { ... }
  services/
    UserService.java     ← import com.example.app.models.User; class UserService { ... }
  models/
    User.java            ← class User { String name; ... }
```

### Layer 3 — E2E Tests (VS Code Extension Host)

New e2e test file: `tests/vscode-e2e/suite/newLanguages.test.ts`

#### Test structure

```typescript
suite('New Languages (C#, Go, Java) Test Suite', () => {
  // Smoke: extension activates on each language file
  // File graph: dependency edges visible between files
  // Call graph: opens without error, produces nodeCount > 0
  // Language icons: node border/color matches language brand color
  // C# project references: .csproj ProjectReference produces graph edge
});
```

#### Test cases

**C#**
```
[E2E-CS-01] Opening a .cs file triggers extension activity (SUPPORTED_SOURCE_FILE_REGEX matches)
[E2E-CS-02] showGraph command produces a graph with CSharp file nodes for csharp-integration fixture
[E2E-CS-03] UserService.cs → Models/User.cs dependency edge is present in graph data
[E2E-CS-04] showCallGraph opens without throwing for a .cs file
[E2E-CS-05] callGraphNodeCount > 0 after opening call graph for UserService.cs
[E2E-CS-06] MyProject.csproj produces dependency edge to OtherProject.csproj (file-level graph)
```

**Go**
```
[E2E-GO-01] Opening a .go file triggers extension activity
[E2E-GO-02] showGraph produces graph with Go file nodes for go-integration fixture
[E2E-GO-03] main.go → services/user.go dependency edge is present
[E2E-GO-04] showCallGraph opens without throwing for a .go file
[E2E-GO-05] callGraphNodeCount > 0 after opening call graph for main.go
```

**Java**
```
[E2E-JAVA-01] Opening a .java file triggers extension activity
[E2E-JAVA-02] showGraph produces graph with Java file nodes for java-integration fixture
[E2E-JAVA-03] Main.java → services/UserService.java dependency edge is present
[E2E-JAVA-04] showCallGraph opens without throwing for a .java file
[E2E-JAVA-05] callGraphNodeCount > 0 after opening call graph for UserService.java
```

**Visual / color**
```
[E2E-COLOR-01] .cs file node border color matches LANGUAGE_COLORS.csharp (#9b4f96)
[E2E-COLOR-02] .go file node border color matches LANGUAGE_COLORS.go (#00acd7)
[E2E-COLOR-03] .java file node border color matches LANGUAGE_COLORS.java (#f8981d)
```

E2E tests follow the same pattern as `callGraph.test.ts`:
- `openCallGraphFor(projectName, fileName)` helper (already in `_helpers.ts`)
- `getContextKey<number>('graph-it-live.callGraphNodeCount')` for node count assertion
- `sleep()` for async settling

---

## Build & Packaging

### `.vscodeignore` additions

The `.vscodeignore` file must include the new WASM files. Verify the existing `!dist/wasm/` glob covers them; if individual entries are required:
```
!dist/wasm/tree-sitter-c_sharp.wasm
!dist/wasm/tree-sitter-go.wasm
!dist/wasm/tree-sitter-java.wasm
```

### Package verification

After implementation, run:
```bash
npm run build -- --production
npm run package
npx vsce ls | grep "\.map$"   # Must be empty
npx vsce ls | grep "c_sharp\|go\.wasm\|java\.wasm"  # Must show all 3
ls -lh *.vsix  # Target: < 20 MB (3 new ~2MB WASM files)
```

---

## Implementation Order

```
Step 1  src/shared/constants.ts             — extension lists, colors, regex, globs
Step 2  src/shared/utils/languageDetection  — LANGUAGE_BY_EXTENSION entries
Step 3  src/shared/callgraph-types.ts       — SupportedLang union type
Step 4  esbuild.js copyWasmFiles()          — copy 3 new WASM files at build time
Step 5  resources/queries/csharp.scm        — C# tree-sitter query
Step 6  resources/queries/go.scm            — Go tree-sitter query
Step 7  resources/queries/java.scm          — Java tree-sitter query
Step 8  GraphExtractor.ts                   — fileExtToLang, langToWasmFileName, MEMBER_ACCESS
Step 9  CallGraphViewService.ts             — toSupportedLang, langFromPath, freshnessCutoffs
Step 10 CSharpParser.ts                     — L1 import parser + .csproj ProjectReference
Step 11 GoParser.ts                         — L1 import parser + go.mod discovery
Step 12 JavaParser.ts                       — L1 import parser + Maven layout
Step 13 LanguageService.ts                  — enum, detectLanguage(), getAnalyzer(), reset()
Step 14 AstWorker.ts                        — detectLanguage() helper update
Step 15 LanguageIcon.tsx                    — SVG icons + LANGUAGE_CONFIGS entries
Step 16 CytoscapeTheme.ts                   — LANG_COLORS entries
Step 17 Unit tests for all 3 parsers        — (mock WasmParserFactory, no real WASM)
Step 18 Unit tests for GraphExtractor       — per-language SCM captures
Step 19 Test fixtures                       — csharp-integration, go-integration, java-integration
Step 20 E2E test file                       — newLanguages.test.ts
Step 21 BuildVerification.test.ts update    — 3 new WASM wasm checks
Step 22 npm run build && package:verify     — zero .map files, WASM present
```

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| `tree-sitter-c_sharp.wasm` uses `dylink` (legacy) | Medium | Build failure | `WasmParserFactory.normalizeLegacyDylinkSection()` shim already handles this |
| C# `using` aliases collide with local vars | Low | False positives | Only process `using_directive` node type, not assignment usings |
| Go multi-module workspace | Low | Missing edges | Best-effort: single nearest `go.mod` only; document limitation |
| Java wildcard imports (`import pkg.*`) produce low-resolution edges | Medium | Low-quality graph | Emit a single edge to the package directory rather than individual files |
| `.csproj` backslash path handling on macOS/Linux | High | Broken resolution | Normalize with `path.normalize()` after replacing `\\` with `/` |
| Package size increases by ~6 MB (3×~2 MB WASM) | Certain | Size budget | Update target to ~22 MB; still below marketplace 50 MB limit |
| `SupportedLang` exhaustive switch failures | Certain (compile-time) | Build error | TypeScript will catch at compile time — upgrade all switch sites |

---

## Open Questions

1. **C# `.csproj` call graph**: should `.csproj` files be excluded from the call graph L2 (they are XML, not C# code)? **Decision**: yes, exclude — `langFromPath()` in `CallGraphViewService` should return `null` for `.csproj`.

2. **Go embedded structs**: how should embedding (`type Bar struct { Foo }`) be represented — as `@inherit` or silently ignored? **Decision for v1**: silently ignored; Go philosophy discourages inheritance framing.

3. **Java anonymous inner classes**: do we extract them as symbols? **Decision for v1**: no — only named top-level class, interface, and enum declarations.

4. **Test fixture location**: should e2e test fixtures go to `tests/fixtures/{lang}-integration/` (unit test fixtures) or `tests/vscode-e2e/fixtures/`? **Decision**: use the existing unified `tests/fixtures/` location so both unit and e2e tests share them.
