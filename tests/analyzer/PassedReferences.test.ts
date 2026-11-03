/**
 * Python and Rust symbol analyzers: a function passed as an argument is a REFERENCES dependency (#575), never
 * a call, and only when the name is proven: a same-file definition not shadowed by a parameter, a local or a
 * closure parameter, a method through `self`/`cls`, an imported name, or a member of an imported module.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { PythonSymbolAnalyzer } from "@/analyzer/languages/PythonSymbolAnalyzer";
import { RustSymbolAnalyzer } from "@/analyzer/languages/RustSymbolAnalyzer";
import { normalizePath } from "@/shared/path";

/** `source -> target:relation@line` per dependency, ids relative to `/ws/`. */
function describeDependencies(deps: Array<{ sourceSymbolId: string; targetSymbolId: string; relation?: string; line?: number }>): string[] {
  const short = (id: string) => id.replace(/^\/ws\//, "");
  return deps.map((d) => `${short(d.sourceSymbolId)} -> ${short(d.targetSymbolId)}:${d.relation ?? "use"}@${d.line}`).sort();
}

describe("PythonSymbolAnalyzer: functions passed as arguments", () => {
  const file = normalizePath("/ws/pkg/run.py");
  const analyzer = new PythonSymbolAnalyzer(process.cwd(), process.cwd());
  const references = (source: string) =>
    describeDependencies(analyzer.analyzeFileContent(file, source).dependencies).filter((d) => d.includes(":REFERENCES@"));

  beforeAll(() => analyzer.ensureInitialized());

  it.each([
    {
      title: "an imported name, positional or keyword, once per target",
      source: "from pkg.h import save\n\ndef run():\n    register(save)\n    register(cb=save)\n",
      expected: ["pkg/run.py:run -> pkg.h:save:REFERENCES@4"],
    },
    {
      title: "a same-file function, also as a default value",
      source: "def local():\n    pass\n\ndef run(x=local):\n    register(local)\n",
      expected: ["pkg/run.py:run -> pkg/run.py:local:REFERENCES@5"],
    },
    {
      title: "a method through self or cls, never through another object",
      source: "class A:\n    def go(self):\n        register(self.done)\n        register(cls.done)\n        register(other.done)\n\n    def done(self):\n        pass\n",
      expected: ["pkg/run.py:go -> pkg/run.py:done:REFERENCES@3"],
    },
    {
      title: "a member of an imported module",
      source: "import pkg.h as h\n\ndef run():\n    register(h.save)\n",
      expected: ["pkg/run.py:run -> pkg.h:save:REFERENCES@4"],
    },
    {
      title: "nothing for a parameter, a typed or splat parameter, or a local named like a function",
      source: "def local():\n    pass\n\ndef a(local):\n    register(local)\n\ndef b(local: int):\n    register(local)\n\ndef c(*local):\n    register(local)\n\ndef d():\n    local = 1\n    register(local)\n",
      expected: [],
    },
    {
      title: "nothing for a call in the argument, a builtin or an unknown name",
      source: "def local():\n    pass\n\ndef run():\n    register(local())\n    register(len)\n    register(missing)\n",
      expected: [],
    },
  ])("records $title", ({ source, expected }) => {
    expect(references(source)).toEqual(expected);
  });
});

describe("RustSymbolAnalyzer: functions passed as arguments", () => {
  const file = normalizePath("/ws/src/main.rs");
  const analyzer = new RustSymbolAnalyzer(process.cwd());
  const references = (source: string) =>
    describeDependencies(analyzer.analyzeFileContent(file, source).dependencies).filter((d) => d.includes(":REFERENCES@"));

  beforeAll(() => analyzer.ensureInitialized());

  it.each([
    {
      title: "a same-file function and a member of a declared module",
      source: "mod helper;\nfn local() {}\nfn run() {\n    register(local);\n    register(helper::save);\n}\n",
      expected: ["src/main.rs:run -> helper:save:REFERENCES@5", "src/main.rs:run -> src/main.rs:local:REFERENCES@4"],
    },
    {
      title: "an imported function",
      source: "use crate::h::save;\nfn run() {\n    register(save);\n}\n",
      expected: ["src/main.rs:run -> crate::h:save:REFERENCES@3"],
    },
    {
      title: "nothing for a parameter, a let, a tuple let or a closure parameter named like a function",
      source: "fn local() {}\nfn a(local: fn()) { register(local); }\nfn b() { let local = 1; register(local); }\nfn c() { let (local, _) = (1, 2); register(local); }\nfn d() { let f = |local: u8| register(local); }\n",
      expected: [],
    },
    {
      title: "nothing for an unknown module, a field or a call in the argument",
      source: "fn local() {}\nfn run(x: X) {\n    register(other::save);\n    register(x.h);\n    register(local());\n}\n",
      expected: [],
    },
  ])("records $title", ({ source, expected }) => {
    expect(references(source)).toEqual(expected);
  });
});
