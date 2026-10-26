# Architecture view, rules and check-architecture

Graph-It-Live draws the architecture of a workspace from its static imports, checks it against rules you write, and exposes the same data in VS Code, the `graph-it` CLI and the MCP server.

## What it answers

- **What are my layers?** Packages (or top-level folders), ordered so that each one imports only those below it, with the loops between them.
- **Who depends on this?** Every package or folder that imports a package, a folder or a file, directly or not.
- **Does the code follow my architecture?** Every import checked against the rules of `graphit.architecture.json`, locally or in CI.

![Architecture view of an npm-workspaces monorepo: units in layers, a cycle between two shared libraries, rule violations in red](../media/architecture-units-overview.png)

*Units in layers with their roles, a cycle outlined, and rule violations (test fixture monorepo). Open it with **Switch to Architecture View** in the title bar of the **Dependency Graph** view.*

## Concepts

Each term has one meaning in this page, the README and [`docs/CLI.md`](CLI.md).

| Term | Meaning |
| --- | --- |
| **File pair** | One file importing another file (static import). Every count in the view is a number of file pairs. |
| **Unit** | A package: a folder holding a `package.json`, workspace member or not, outside `node_modules`. Without any package below the root, each top-level folder is a unit. Files outside every package form the `(root)` unit. |
| **Group** | A node of one level: a unit, a folder inside a unit, or a Louvain community. |
| **Level** | What the view draws at once: the units, the folders of an entered unit or folder, or the Louvain communities. |
| **Edge** | The file pairs from one group to another of the same level. |
| **Layer** | Depth of a group in its level: layer 0 depends on no other group; a group sits one layer above the deepest group it imports. |
| **Cycle** | Groups that import each other, directly or not. They share a layer. |
| **Upward edge** | An edge to a group of the same or a higher layer. Drawn red, like the edges of a cycle. |
| **Role** | What a unit is (`function`, `frontend`, `library`…), inferred from its manifest and files, or declared. See [Roles](#roles). |
| **Element** | A named set of files in `graphit.architecture.json`, selected by path, unit or role. |
| **Rule** | What the files of an element may or may not import. |
| **Baseline** | The violations you accept for now, in `graphit.architecture.baseline.json`. Only new violations fail. |

Groups follow the `graph-it-live.communityMode` setting (CLI `--communities`, MCP `communityMode`):

- `path` (default): units, then folders. Units and folder levels exist only in this mode.
- `louvain`: communities of files that import each other, one flat level.

![Concepts: a workspace holds units, a unit holds folder groups, a group holds files; unit edges and file pairs link them](architecture/architecture-concepts.svg)

*A workspace holds units; entering a unit shows its folder groups; entering a group shows its files. Source: [`architecture/architecture-concepts.mmd`](architecture/architecture-concepts.mmd).*

## By task

### Explore the architecture

1. Open the **Dependency Graph** view in the Activity Bar.
2. Click **Switch to Architecture View** (icon `$(type-hierarchy)`) in its title bar.
3. Read the header: units, layers, upward edges, cycles and hidden edges.
4. Double-click a unit to enter its folders; double-click a folder holding sub-folders to go one level deeper.
5. Go back with the breadcrumb or *Escape*.

CLI: `graph-it architecture --level units`, then `graph-it architecture --folder <key>`.

![Navigating Graph-It-Live's architecture: enter src, then analyzer, Fit the whole level, go back with the breadcrumb](../media/architecture-navigate-groups.gif)

*Graph-It-Live itself: double-click `src`, then `analyzer`, press *Fit*, then go back with the breadcrumb.*

### See the imports behind an edge

1. Click an edge. The evidence panel lists its file pairs, 50 at a time.
2. Click a file to open it at the import.

CLI: `graph-it architecture --level units --from <unit> --to <unit>`.

![Clicking a unit edge lists its file pairs; clicking a file opens it at the import](../media/architecture-edge-evidence.gif)

*Click an edge for the file pairs behind it, then a file to open it.*

### Find who depends on a file, folder or unit

1. Select the node: click it, use the arrow keys, the units legend or a matrix row.
2. Click **Dependents by group** in the action bar at the bottom left (or right-click the node).
3. Read the *Dependents* tab: one row per group, with its direct importers, all its dependents and the minimum depth (1 = imports the selection directly), nearest first.
4. Expand a row to list its files; click a file to open it.

Counts use every static import of the workspace, drawn or not. Dependents inside the selection's own group are counted apart. Runtime-only use (reflection, string paths) is not seen. For symbol-level impact, use `get_impact_analysis`.

![Selecting a unit, running Dependents by group, and expanding one group's files](../media/architecture-selection-dependents.gif)

*Select a unit, a group or a file, then **Dependents by group** in the bottom-left action bar.*

### Read the dependency structure matrix

1. Click **Matrix** in the *Graph | Matrix* switch.
2. Read each cell: file pairs where a file of the row imports a file of the column. The diagonal counts pairs inside a group.
3. Look above the diagonal: rows are ordered by layer, so a cell there (red) belongs to a cycle.

Each row header shows `Ca/Ce · I`: incoming pairs, outgoing pairs and the instability `I = Ce / (Ca + Ce)`. CLI: `graph-it architecture --level units --matrix` (`--format csv` for a spreadsheet).

![Dependency structure matrix of Graph-It-Live's src folder: every cell below the diagonal, no cycle](../media/architecture-matrix.png)

*Matrix of Graph-It-Live's `src`: a layered architecture fills only the lower triangle. Enter a unit, then click **Matrix**.*

### Check rules locally

1. Write `graphit.architecture.json` at the workspace root (see [The config file](#the-config-file)).
2. Click **Refresh** in the Architecture view. The Rules panel shows "N violations of M rules (K new)", or "All N rules pass".
3. Click a rule to list its violating file pairs; click a file to open it at the import.
4. Or run `graph-it check-architecture` in a terminal.

Violating edges are dashed red; violating matrix cells are framed red.

![Architecture view Rules panel: clicking a rule lists its violating file pairs, clicking a file opens it at the import](../media/architecture-rules-violations.gif)

*Rules panel of an npm-workspaces monorepo (test fixture). Add `graphit.architecture.json` at the workspace root to get the panel.*

### Fail CI on a forbidden import

1. Commit `graphit.architecture.json`.
2. Add `npx graph-it check-architecture` to the pipeline. It exits with 1 when an `error` rule has a violation that is not in the baseline.
3. Optional, for GitHub code scanning: write SARIF and upload it.

```yaml
- run: npx graph-it check-architecture --format sarif > architecture.sarif
- uses: github/codeql-action/upload-sarif@v3
  if: always()
  with:
    sarif_file: architecture.sarif
```

Each new violation is then annotated on the importing line. Other exit codes are listed in [`docs/CLI.md`](CLI.md#check-architecture).

![Terminal running graph-it check-architecture on Graph-It-Live: passed true, 8 rules, 0 violations, exit code 0](../media/cli-check-architecture.png)

*`graph-it check-architecture` on this repository: 8 rules, every file in an element, no violation, exit code 0.*

### Adopt rules on existing code

1. Write the rules you want, even if the code breaks them today.
2. Run `graph-it check-architecture --update-baseline`. It writes every current violation to `graphit.architecture.baseline.json`.
3. Commit the baseline. From now on, only new violations fail.
4. Fix violations over time, then run `--update-baseline` again: resolved entries leave the file.

The baseline holds workspace-relative `/` paths, so it is identical on Linux, macOS and Windows.

## Same data, three surfaces

The view, the CLI and the MCP server build the same graph: for the same community mode and file limit, counts are equal.

| Task | VS Code Architecture view | CLI | MCP tool |
| --- | --- | --- | --- |
| Units, layers, roles | Opens on units (`path` mode) | `graph-it architecture --level units` | `explore_architecture` with `level: "units"` |
| Groups | `graph-it-live.communityMode` setting | `graph-it architecture --groups` | `explore_architecture` (summary) |
| One level down | Double-click a unit or folder | `--folder <key>` | `folder` |
| One group's files and edges | Double-click a group without sub-folders | — | `group` |
| File pairs behind an edge | Click the edge | `--level units --from <unit> --to <unit>` | `from` and `to` |
| Matrix | *Graph \| Matrix* switch | `--matrix` (`--format csv`) | `view: "matrix"` |
| Dependents by group | **Dependents by group** action | — | — (use `find_referencing_files` or `get_impact_analysis`) |
| Check rules | Rules panel | `graph-it check-architecture` | `check_architecture` |
| Write the baseline | — | `check-architecture --update-baseline` | — |

All options and output fields: [`architecture`](CLI.md#architecture), [`check-architecture`](CLI.md#check-architecture), [`explore_architecture`](CLI.md#explore_architecture), [`check_architecture`](CLI.md#check_architecture).

## View controls

| Action | Mouse | Keyboard |
| --- | --- | --- |
| Focus the canvas | Click it | *Tab* |
| Select a group | Click | Arrow keys (nearest group in that direction) |
| Highlight neighbours | Hover or click a group or edge | — |
| Enter a unit, folder or group | Double-click | *Enter* |
| Go back one level | Breadcrumb step, or *×* | *Escape* |
| Clear the selection | Click the background, or *Clear* | *Escape* (see below) |
| List an edge's file pairs | Click the edge | — |
| Selection actions | Action bar (bottom left), or right-click | *Tab* to the action bar |
| Fit, zoom in, zoom out | Buttons (bottom right) | *0*, *+*, *-* |
| Switch graph and matrix | *Graph \| Matrix* | — |
| Move in the matrix | Click a cell or row header | Arrow keys, *Enter* on a row header |
| Find a group | *Find group* box | — |
| Hide weak edges | *Min. imports per edge* | — |
| Draw more groups | *Show more groups* | — |
| Show only one role | Click the role in the units legend | — |

*Escape* steps back one thing at a time: it closes the action menu, then the evidence or dependents panel, then leaves the entered group or focus, then goes up one level, back to the units.

A screen reader announces the selected group's name, layer, edges and cycle.

The view is built when it opens, on **Refresh**, and when `graph-it-live.communityMode` changes. Changing source files, `graphit.architecture.json`, its baseline, a `package.json` or a `tsconfig*.json` shows a *Files changed* banner: you decide when to **Refresh**.

## Roles

A role describes a unit. It comes from the unit's manifest, top-level configs, `index.html` and entry file, never from the code's meaning. Each file read stays inside the workspace and under 1 MiB; nothing is executed.

| Role | Evidence (any of) |
| --- | --- |
| `function` | `@types/aws-lambda`, `aws-lambda`, `@azure/functions` or `firebase-functions` dependency; `serverless.yml`, `host.json`, or a SAM `template.yaml` in the unit; an exported `handler` in its entry (`main`, `index.*`, `handler.*`) |
| `micro-frontend` | `@module-federation/*` or `single-spa` dependency; `ModuleFederationPlugin` in a bundler config |
| `frontend` | `react`, `vue`, `@angular/core`, `svelte` or `solid-js` dependency, with an `index.html` or a bundler config (vite, webpack, next, nuxt, rspack, `angular.json`) |
| `service` | `express`, `fastify`, `@nestjs/core`, `koa` or `hono` dependency; a `Dockerfile` with `EXPOSE` |
| `library` | none of the above, and imported by another unit (unless all its files are tooling) |
| `tooling` | only scripts, tests or config files (`scripts/`, `tools/`, `e2e/`, `tests/`, `.github/`, `*.test.*`, `*.config.*`), even when imported |
| `unknown` | nothing conclusive |

A unit matching several roles takes the first in the table; the other matches stay as evidence. The badge reads `[role?]` when inferred and `[role]` when declared; its tooltip lists the evidence.

![Units legend with role badges; the libraries filter keeps only the five library units](../media/architecture-roles-filter.png)

*`[library?]` is inferred, `[library]` declared. Click a role in the legend to keep only its units.*

## The config file

`graphit.architecture.json` sits at the workspace root. It has three optional top-level keys. Do not mix up `rules` and `roles`:

| Key | Answers | Effect |
| --- | --- | --- |
| `elements` | Which files belong together? | Names sets of files for the rules |
| `rules` | Which imports are allowed? | Violations in the view, `check-architecture` exit code |
| `roles` | What is each unit? | Badge `[role]` instead of `[role?]`, legend counts, `role` selectors of elements |

A file without `rules` checks nothing. Rules are your annotation: the tool only compares import pairs with them.

### Example

A monorepo with serverless functions, a frontend, micro-frontends, a backend and shared libraries:

```json
{
  "$schema": "https://raw.githubusercontent.com/magic5644/Graph-It-Live/main/schemas/architecture.schema.json",
  "elements": {
    "functions": { "path": "functions/*", "each": true },
    "frontend": { "path": "frontend/" },
    "mfe": { "path": "mfe/*", "each": true },
    "backend": { "path": "backend/" },
    "shared": { "unit": ["@acme/shared-*"] }
  },
  "rules": [
    { "name": "functions-only-shared", "from": "functions", "allowOnly": ["shared"], "severity": "error",
      "reason": "Functions are deployed alone; they share code only through libraries." },
    { "name": "frontend-not-backend", "from": ["frontend", "mfe"], "forbid": ["backend"], "severity": "error" },
    { "name": "mfe-isolated", "from": "mfe", "forbid": ["mfe"], "severity": "warning" },
    { "name": "no-unit-cycles", "noCycles": "units", "severity": "error" }
  ],
  "roles": {
    "@acme/shared-*": "library",
    "tools/*": "tooling"
  }
}
```

### Elements

An element selects files by any of:

- `path`: workspace-relative gitignore-style patterns, as in `.graphitignore`.
- `unit`: unit keys or package names from `graph-it architecture --level units`; `*` matches any characters.
- `role`: unit roles, for example `{ "role": "function" }`.

With `each: true`, every matched folder or unit is an instance of its own. `mfe → mfe` then means "another micro-frontend", never a file of the same one. A file can belong to several elements.

### Rules

| Field | Meaning |
| --- | --- |
| `forbid` | Files of `from` may not import these elements |
| `allowOnly` | Files of `from` may import only these elements and their own instance; a target in no element is a violation |
| `noCycles` | `"units"` or an `each` element: no import cycle between them |
| `severity` | `error` (default, fails `check-architecture`), `warning`, or `off` (not checked) |
| `reason` | Shown with every violation |

A rule that could never report is refused: `noCycles` on an element without `each`, or `forbid` of the element it comes `from` without `each`.

### Roles key

`roles` maps unit keys or package names to a role; `*` matches any characters and the first match wins. It only replaces the inferred role: it is not a rule. Its keys are unit keys or package names, never element names.

### Write the file for your workspace

1. Run `graph-it architecture --level units` (or open the Architecture view) and note the unit keys.
2. Under `elements`, name each part of your architecture by `path`, `unit` or `role`. Every source file should belong to an element: `check-architecture` reports the others as `unmatchedFiles`.
3. Under `rules`, write what each element may import (`allowOnly`) or must not import (`forbid`), with a `reason`.
4. Optionally, under `roles`, fix every role the view infers wrongly or marks `[unknown?]`.
5. Run `graph-it check-architecture`: it should report 0 violations, no unmatched file and no config warning.

A single-package repository has its top-level folders as units. Graph-It-Live's own [`graphit.architecture.json`](../graphit.architecture.json) is one: its elements split `src/` into layers, and `roles` declares the units:

```json
"roles": {
  "src": "library",
  "tests": "tooling",
  "scripts": "tooling",
  ".github": "tooling",
  "(root)": "tooling"
}
```

The config is validated before anything runs; each error names its JSON path. A pattern matching no file is a config warning. The `$schema` line gives completion and validation in editors. Full key reference: [`docs/CLI.md`](CLI.md#architecture-rules).

## Limits

- **Static imports only.** Dynamic imports the analyzer resolves count; runtime-only use does not.
- **Units and folder levels need `path` mode.** `louvain` gives one flat level of communities; their ids change with the code, so match them by `key`.
- **Groups drawn per level**: the 50 largest; *Show more groups* draws up to 150 for the session. Header totals, *Find*, the matrix, dependents and rules still cover every group.
- **Unit edges drawn**: the 3 strongest per unit; upward and cycle edges always. *Min. imports per edge* shows edges by weight instead.
- **Files in an entered group**: 200 at a time, most imported first; at most 500 files drawn at once.
- **Lists**: evidence and dependents files, 50 at a time; MCP pages default to 50 items, 500 at most.
- **Config size**: `graphit.architecture.json` up to 256 KB, baseline up to 32 MB; `--config` and `--baseline` must stay inside the workspace.
- **Workspace**: the view analyses the configured workspace folder. Of the rules files, it reads only `graphit.architecture.json` and `graphit.architecture.baseline.json` at its root; `--config` and `--baseline` name others for the CLI and MCP.

## How it is built

![Graph-It-Live system architecture: the src/analyzer/architecture module and its consumers in the extension, the CLI and the MCP server](architecture/graph-it-live-architecture.svg)

*`src/analyzer/architecture/` builds the file graph, units, roles, rules and matrix; the extension's `ArchitectureViewService`, the CLI commands `architecture` and `check-architecture`, and the MCP tools `explore_architecture` and `check_architecture` use it. Source: [`architecture/graph-it-live-architecture.mmd`](architecture/graph-it-live-architecture.mmd).*
