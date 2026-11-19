import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanUnreferencedFiles } from "@/analyzer/deadcode/DeadCodeScanner";
import { SpiderBuilder } from "@/analyzer/SpiderBuilder";

/**
 * #774: per language, an import that deterministically names a missing workspace file is reported; a library
 * import is not. C# `using` names a namespace, never a file: not reported.
 */
describe("unresolved imports in other languages (#774)", () => {
  const roots: string[] = [];
  const spiders: Array<{ dispose(): Promise<void> }> = [];
  afterEach(async () => {
    await Promise.all(spiders.splice(0).map((spider) => spider.dispose()));
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  async function workspace(files: Record<string, string>) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "graph-it-unresolved-lang-")));
    roots.push(root);
    for (const [file, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), content);
    }
    const spider = new SpiderBuilder().withRootDir(root).withExtensionPath(process.cwd()).withReverseIndex(true).build();
    spiders.push(spider);
    await spider.buildFullIndex();
    const report = (await scanUnreferencedFiles(spider, root, {})).unresolvedImports;
    return { spider, root, report };
  }

  it("Go: an import under the go.mod module path whose package folder has no .go file", async () => {
    const { report } = await workspace({
      "go.mod": "module example.com/app\n\ngo 1.22\n",
      "main.go": 'package main\n\nimport (\n\t"fmt"\n\t"example.com/app/util"\n\t"example.com/app/gen/api"\n\t"github.com/acme/lib"\n)\n\nfunc main() { fmt.Println(util.X, api.Y, lib.Z) }\n',
      "util/util.go": "package util\n\nconst X = 1\n",
    });

    expect(report?.examples).toEqual([{ file: "main.go", specifier: "example.com/app/gen/api" }]);
  }, 60_000);

  it("Rust: a mod declaration with no file, never a use path", async () => {
    const { report } = await workspace({
      "Cargo.toml": '[package]\nname = "app"\nversion = "0.1.0"\n',
      "src/main.rs": "mod generated;\nmod util;\nuse serde_json::Value;\nfn main() { util::run(); }\n",
      "src/util.rs": "pub fn run() {}\n",
    });

    expect(report?.examples).toEqual([{ file: "src/main.rs", specifier: "generated" }]);
  }, 60_000);

  it("Python: a relative module and a submodule of a workspace package, never the standard library or a site package", async () => {
    const { report } = await workspace({
      "pyproject.toml": '[project]\nname = "app"\n',
      "pkg/__init__.py": "",
      "pkg/helpers.py": "def f():\n    return 1\n",
      "pkg/app.py": "import os.path\nimport requests.adapters\nimport pkg.generated_api\nfrom pkg import helpers\nfrom .models_gen import User\n",
    });

    expect(report?.examples).toEqual([
      { file: "pkg/app.py", specifier: ".models_gen" },
      { file: "pkg/app.py", specifier: "pkg.generated_api" },
    ]);
  }, 60_000);

  // Regression: a workspace whose files import nothing of each other has an index with no edge, not no index.
  it("Python: scans the unreferenced files of a workspace without any import edge", async () => {
    const { report, spider, root } = await workspace({
      "pyproject.toml": '[project]\nname = "app"\n',
      "a.py": "import os\n",
      "b.py": "def f():\n    return 1\n",
    });

    expect(report).toMatchObject({ count: 0 });
    expect((await scanUnreferencedFiles(spider, root, {})).scannedFiles).toBeGreaterThan(0);
  }, 60_000);

  it("Java: a class of a package the source root holds, never the JDK, wildcards or other libraries", async () => {
    const { report } = await workspace({
      "pom.xml": "<project></project>\n",
      "src/main/java/com/acme/app/App.java":
        "package com.acme.app;\n\nimport java.util.List;\nimport org.junit.Test;\nimport com.acme.app.Util;\nimport com.acme.app.Generated;\nimport com.acme.app.model.*;\n\npublic class App {}\n",
      "src/main/java/com/acme/app/Util.java": "package com.acme.app;\n\npublic class Util {}\n",
    });

    expect(report?.examples).toEqual([{ file: "src/main/java/com/acme/app/App.java", specifier: "com.acme.app.Generated" }]);
  }, 60_000);

  it("C#: a using of a missing namespace is not reported", async () => {
    const { report } = await workspace({
      "App.csproj": "<Project></Project>\n",
      "Program.cs": "using System;\nusing MyApp.Generated;\n\nnamespace MyApp { class Program { static void Main() {} } }\n",
    });

    expect(report).toMatchObject({ count: 0, excludedCount: 0 });
  }, 60_000);
});
