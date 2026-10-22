import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** The example of "Architecture rules" in the docs: what the generated workspace is checked against. */
export const RULES_CONFIG = {
  $schema: "https://raw.githubusercontent.com/magic5644/Graph-It-Live/main/schemas/architecture.schema.json",
  elements: {
    functions: { path: "functions/*", each: true },
    frontend: { path: "frontend/" },
    mfe: { path: "mfe/*", each: true },
    backend: { path: "backend/" },
    shared: { unit: ["@acme/shared-*"] },
  },
  rules: [
    { name: "functions-only-shared", from: "functions", allowOnly: ["shared"], severity: "error",
      reason: "Functions are deployed alone; they share code only through libraries." },
    { name: "frontend-not-backend", from: ["frontend", "mfe"], forbid: ["backend"], severity: "error" },
    { name: "mfe-isolated", from: "mfe", forbid: ["mfe"], severity: "warning" },
    { name: "no-unit-cycles", noCycles: "units", severity: "error" },
  ],
};

const pkg = (name: string, main?: string) => JSON.stringify({ name, private: true, main });

/**
 * npm workspaces: two functions, a frontend, two micro-frontends, a backend, two shared
 * libraries in a cycle, and a root script no element selects. Each import below is either
 * allowed or breaks exactly one rule of RULES_CONFIG.
 */
const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "acme", private: true, workspaces: ["functions/*", "frontend", "mfe/*", "backend", "shared/*"] }),
  "functions/billing/package.json": pkg("@acme/fn-billing"),
  // allowed: shared; breaks functions-only-shared: backend
  "functions/billing/index.ts": 'import { log } from "@acme/shared-utils";\nimport { query } from "../../backend/src/db";\nexport const bill = () => log(query());\n',
  "functions/mail/package.json": pkg("@acme/fn-mail"),
  // breaks functions-only-shared: another function
  "functions/mail/index.ts": 'import { bill } from "../billing/index";\nexport const mail = () => bill();\n',
  "frontend/package.json": pkg("@acme/frontend"),
  // allowed: shared; breaks frontend-not-backend
  "frontend/src/app.ts": 'import { button } from "@acme/shared-ui";\nimport { api } from "../../backend/src/api";\nexport const app = () => button(api());\n',
  "mfe/cart/package.json": pkg("@acme/mfe-cart"),
  // same instance: allowed; another micro-frontend: breaks mfe-isolated
  "mfe/cart/src/index.ts": 'import { view } from "./view";\nimport { pay } from "../../checkout/src/index";\nexport const cart = () => view(pay());\n',
  "mfe/cart/src/view.ts": "export const view = (value: string) => value;\n",
  "mfe/checkout/package.json": pkg("@acme/mfe-checkout"),
  "mfe/checkout/src/index.ts": 'import { button } from "@acme/shared-ui";\nexport const pay = () => button("pay");\n',
  "backend/package.json": pkg("@acme/backend"),
  "backend/src/api.ts": 'import { query } from "./db";\nexport const api = () => query();\n',
  "backend/src/db.ts": 'import { log } from "@acme/shared-utils";\nexport const query = () => log("select");\n',
  // shared-utils ⇄ shared-ui: breaks no-unit-cycles both ways
  "shared/utils/package.json": pkg("@acme/shared-utils", "src/index.ts"),
  "shared/utils/src/index.ts": 'import { button } from "@acme/shared-ui";\nexport const log = (value: string) => value;\nexport const debug = () => button("debug");\n',
  "shared/ui/package.json": pkg("@acme/shared-ui", "src/index.ts"),
  "shared/ui/src/index.ts": 'import { log } from "@acme/shared-utils";\nexport const button = (label: string) => log(label);\n',
  "scripts/seed.ts": 'import { query } from "../backend/src/db";\nexport const seed = () => query();\n',
};

/** Writes the workspace (and the config, unless `withConfig` is false) into a new temporary folder. */
export function createRulesWorkspace(withConfig = true): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "graphit-rules-"));
  const files = withConfig ? { ...FILES, "graphit.architecture.json": JSON.stringify(RULES_CONFIG, null, 2) } : FILES;
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
  // npm install links the workspace packages; junctions need no privilege on Windows.
  for (const [name, folder] of [["shared-utils", "shared/utils"], ["shared-ui", "shared/ui"]]) {
    fs.mkdirSync(path.join(root, "node_modules", "@acme"), { recursive: true });
    fs.symlinkSync(path.join(root, folder), path.join(root, "node_modules", "@acme", name), "junction");
  }
  // realpath: macOS tmpdir is a symlink (/var → /private/var), which the workspace checks resolve.
  return fs.realpathSync(root);
}
