// Writes src/resolvers.generated.ts: one lazy import per resolver module.
import { readdirSync, writeFileSync } from "node:fs";

const names = readdirSync(new URL("../src/resolvers", import.meta.url)).map((file) => file.replace(/\.ts$/, ""));
const entries = names.map((name) => `    ${name}: (await import("./resolvers/${name}")).${name},`).join("\n");
writeFileSync(
  new URL("../src/resolvers.generated.ts", import.meta.url),
  `export async function resolvers(): Promise<Record<string, unknown>> {\n  return {\n${entries}\n  };\n}\n`,
);
