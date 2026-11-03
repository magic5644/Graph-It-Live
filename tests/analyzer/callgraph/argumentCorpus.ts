/**
 * Functions passed as arguments in every call graph language (#575): `expected` lists the REFERENCES (and CALLS)
 * edges of `source` the call graph stores, with 0-based lines. `symbolPipeline` marks the cases the symbol
 * analyzers (ts-morph, Python, Rust) must report identically; TypeScript class methods are recorded under their
 * class there, so that case is left out.
 */
export interface ArgumentCase {
  lang: string;
  files: Record<string, string>;
  source: string;
  expected: string[];
  symbolPipeline?: boolean;
}

export const ARGUMENT_CASES: ArgumentCase[] = [
  {
    lang: "TypeScript", symbolPipeline: true,
    files: {
      "src/h.ts": "export function save() {}\n",
      "src/run.ts": `import { save } from './h';
function local() {}
export function run(cb: () => void, list: number[]) {
  register(save); register(local); register(cb);
  list.map(format); register(list.length);
  register(save());
}
`,
    },
    source: "src/run.ts#run",
    expected: [
      "src/run.ts#run -CALLS@5-> src/h.ts#save",
      "src/run.ts#run -REFERENCES@3-> src/h.ts#save",
      "src/run.ts#run -REFERENCES@3-> src/run.ts#local",
    ],
  },
  {
    lang: "TypeScript, a parameter, a local or a `self` variable named like a function", symbolPipeline: true,
    files: {
      "src/shadow.ts": `function save() {}
export function a(save: () => void) { register(save); }
export function b() { const save = 1; register(save); }
export const c = (save: () => void) => register(save);
export function d() { const self = { save }; register(self.save); }
export function ok() { register(save); }
`,
    },
    source: "src/shadow.ts#",
    expected: ["src/shadow.ts#ok -REFERENCES@5-> src/shadow.ts#save"],
  },
  {
    lang: "TypeScript, a method through this only",
    files: {
      "src/members.ts": `function save() {}
export class C { save() {} go() { register(this.save); register(other.save); } }
`,
    },
    source: "src/members.ts#",
    expected: ["src/members.ts#go -REFERENCES@1-> src/members.ts#save"],
  },

  {
    lang: "Python", symbolPipeline: true,
    files: {
      "pkg/h.py": "def save():\n    pass\n",
      "pkg/run.py": `from pkg.h import save

def local():
    pass

def run(cb):
    register(save)
    register(callback=local)
    register(cb)
    register(len)
    register(save())

class A:
    def go(self):
        register(self.done)
        register(other.done)

    def done(self):
        pass
`,
    },
    source: "pkg/run.py#",
    expected: [
      "pkg/run.py#go -REFERENCES@14-> pkg/run.py#done",
      "pkg/run.py#run -CALLS@10-> pkg/h.py#save",
      "pkg/run.py#run -REFERENCES@6-> pkg/h.py#save",
      "pkg/run.py#run -REFERENCES@7-> pkg/run.py#local",
    ],
  },
  {
    lang: "Rust", symbolPipeline: true,
    files: {
      "src/helper.rs": "pub fn save() {}\n",
      "src/main.rs": `mod helper;
fn local() {}
fn run(cb: fn()) {
    let x = 1;
    register(helper::save);
    register(local);
    register(cb);
    register(x);
}
`,
    },
    source: "src/main.rs#run",
    expected: ["src/main.rs#run -REFERENCES@4-> src/helper.rs#save", "src/main.rs#run -REFERENCES@5-> src/main.rs#local"],
  },
  {
    lang: "Go",
    files: {
      "p/a.go": `package p
func local() {}
func run(cb func()) {
	v := local
	register(local)
	register(other)
	register(cb)
	register(v)
}
`,
      "p/b.go": "package p\nfunc other() {}\n",
    },
    source: "p/a.go#run",
    expected: ["p/a.go#run -REFERENCES@4-> p/a.go#local", "p/a.go#run -REFERENCES@5-> p/b.go#other"],
  },
  {
    lang: "Go, files at the workspace root",
    files: {
      "a.go": "package main\nfunc run() { register(other) }\n",
      "b.go": "package main\nfunc other() {}\n",
    },
    source: "a.go#run",
    expected: ["a.go#run -REFERENCES@1-> b.go#other"],
  },
  {
    lang: "Python, a same-file definition next to a wildcard import", symbolPipeline: true,
    files: {
      "pkg/star.py": "from os.path import *\n\ndef local():\n    pass\n\ndef run():\n    register(local)\n",
    },
    source: "pkg/star.py#run",
    expected: ["pkg/star.py#run -REFERENCES@6-> pkg/star.py#local"],
  },
  {
    lang: "Java",
    files: {
      "src/A.java": `class A {
  void run() { register(this::save); register(String::valueOf); }
  void save() {}
  void valueOf() {}
}
`,
    },
    source: "src/A.java#run",
    expected: ["src/A.java#run -REFERENCES@1-> src/A.java#save"],
  },
  {
    lang: "C#",
    files: {
      "src/A.cs": `class A {
  void Run(System.Action cb) { var v = 1; Register(Save); Register(this.Done); Register(Helper.Do); Register(cb); Register(v); Register(other.Save); }
  void Save() {}
  void Done() {}
}
class Helper { public static void Do() {} }
`,
    },
    source: "src/A.cs#Run",
    expected: [
      "src/A.cs#Run -REFERENCES@1-> src/A.cs#Do",
      "src/A.cs#Run -REFERENCES@1-> src/A.cs#Done",
      "src/A.cs#Run -REFERENCES@1-> src/A.cs#Save",
    ],
  },
];
