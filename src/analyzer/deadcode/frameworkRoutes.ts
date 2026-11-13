/**
 * Files a framework loads by file name (#728): file-based routes, hooks and auto-imported folders, which no import
 * shows. Only when the nearest package.json uses the framework. Pure functions; no I/O.
 */
import path from "node:path";

/** `convention:framework-route`: an excluded unreferenced file, and the exports of such a file. */
export const FRAMEWORK_ROUTE = "convention:framework-route";

const SCRIPT = "[cm]?[jt]sx?";
/** An optional `src/` or `app/` root, as several frameworks accept either. */
const IN = (roots: string) => `^(?:${roots}/)?`;
/** A Nuxt layer folder, auto-registered under layers/. */
const NUXT = "^(?:layers/[^/]+/)?";

interface Framework {
  /** Whether a dependency name belongs to the framework */
  uses: (dependency: string) => boolean;
  /** Paths relative to the package folder, `/`-separated */
  files: RegExp[];
}

const NEXT_APP_FILES =
  "page|layout|template|loading|error|global-error|global-not-found|not-found|forbidden|unauthorized|default|route|" +
  "opengraph-image|twitter-image|icon|apple-icon|sitemap|robots|manifest";

const FRAMEWORKS: readonly Framework[] = [
  {
    // Next.js: App Router special files, every Pages Router file (pages/api too), middleware and instrumentation.
    uses: (name) => name === "next",
    files: [
      new RegExp(String.raw`${IN("src")}app/(?:.+/)?(?:${NEXT_APP_FILES})\.${SCRIPT}$`),
      new RegExp(String.raw`${IN("src")}pages/.+\.${SCRIPT}$`),
      new RegExp(String.raw`${IN("src")}(?:middleware|proxy|instrumentation|instrumentation-client)\.${SCRIPT}$`),
    ],
  },
  {
    uses: (name) => name === "@sveltejs/kit",
    files: [
      new RegExp(String.raw`^src/routes/(?:.+/)?\+(?:page|layout|server|error)(?:\.server)?(?:@[^/]*)?\.(?:svelte|${SCRIPT})$`),
      new RegExp(String.raw`^src/(?:hooks(?:\.server|\.client)?|service-worker|instrumentation\.server|env)\.${SCRIPT}$`),
      new RegExp(String.raw`^src/params/[^/]+\.${SCRIPT}$`),
    ],
  },
  {
    // Remix and React Router in framework mode.
    uses: (name) => name.startsWith("@remix-run/") || name === "@react-router/dev",
    files: [
      new RegExp(String.raw`^app/routes/.+\.${SCRIPT}$`),
      new RegExp(String.raw`^app/(?:root|routes|entry\.client|entry\.server)\.${SCRIPT}$`),
    ],
  },
  {
    // Nuxt: routed and auto-imported folders at the root (Nuxt 3) or under app/ (Nuxt 4), the same in each auto-registered
    // layer (layers/<name>/), local modules, and Nitro's server folders.
    uses: (name) => name === "nuxt",
    files: [
      new RegExp(String.raw`${NUXT}(?:app/)?(?:pages|layouts|middleware|plugins|components|composables|utils)/.+\.(?:vue|${SCRIPT})$`),
      new RegExp(String.raw`${NUXT}(?:app/)?(?:app|error)\.vue$`),
      new RegExp(String.raw`${NUXT}(?:app/)?router\.options\.${SCRIPT}$`),
      new RegExp(String.raw`${NUXT}modules/[^/]+(?:/index)?\.${SCRIPT}$`),
      new RegExp(String.raw`${NUXT}server/(?:api|routes|middleware|plugins|utils|tasks)/.+\.${SCRIPT}$`),
      new RegExp(String.raw`${NUXT}shared/(?:utils|types)/.+\.${SCRIPT}$`),
    ],
  },
  {
    // Nuxt modules that load a folder by convention.
    uses: (name) => name === "@nuxtjs/mcp-toolkit",
    files: [new RegExp(String.raw`${NUXT}server/mcp/.+\.${SCRIPT}$`)],
  },
  {
    uses: (name) => name === "nuxt-workers",
    files: [new RegExp(String.raw`${NUXT}(?:app/)?workers/[^/]+\.${SCRIPT}$`)],
  },
  {
    // Eve agents: channels, tools, hooks and schedules under agent/, in the package or a Nuxt layer.
    uses: (name) => name === "eve",
    files: [new RegExp(String.raw`${NUXT}agent/.+\.${SCRIPT}$`)],
  },
  {
    uses: (name) => name === "astro",
    files: [
      new RegExp(String.raw`^src/pages/.+\.${SCRIPT}$`),
      new RegExp(String.raw`^src/(?:middleware|content/config|content\.config|actions/index)\.${SCRIPT}$`),
    ],
  },
  {
    uses: (name) => name === "expo-router",
    files: [new RegExp(String.raw`${IN("src")}app/.+\.${SCRIPT}$`)],
  },
  {
    uses: (name) => name === "gatsby",
    files: [new RegExp(String.raw`^src/(?:pages|api)/.+\.${SCRIPT}$`), new RegExp(String.raw`^gatsby-(?:node|browser|ssr)\.${SCRIPT}$`)],
  },
  {
    // Storybook loads every story file by glob.
    uses: (name) => name === "storybook" || name.startsWith("@storybook/"),
    files: [new RegExp(String.raw`(?:^|/)[^/]+\.stories\.${SCRIPT}$`)],
  },
];

/** The indexes in FRAMEWORKS of the frameworks a package.json depends on (any dependency field); none when unparsable. */
export function packageFrameworks(packageJson: string): number[] {
  let manifest: unknown;
  try {
    manifest = JSON.parse(packageJson);
  } catch {
    return [];
  }
  if (typeof manifest !== "object" || manifest === null) return [];
  const names = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].flatMap((field) => {
    const deps = (manifest as Record<string, unknown>)[field];
    return typeof deps === "object" && deps !== null ? Object.keys(deps) : [];
  });
  return FRAMEWORKS.flatMap((framework, index) => (names.some(framework.uses) ? [index] : []));
}

/**
 * Whether a framework of a package.json above `filePath` loads the file by name, its patterns read from that package's
 * folder: a Nuxt layer with its own package.json (layers/x/) still follows the app's conventions, while a sibling package
 * (packages/ui/app/page.tsx under a Next.js root) matches no anchored pattern. `frameworksByPackage` maps every
 * package.json folder (absolute, normalized) to its frameworks (packageFrameworks).
 */
export function isFrameworkRoute(filePath: string, frameworksByPackage: ReadonlyMap<string, readonly number[]>): boolean {
  for (let dir = path.posix.dirname(filePath); ; dir = path.posix.dirname(dir)) {
    const relative = path.posix.relative(dir, filePath);
    const frameworks = frameworksByPackage.get(dir) ?? [];
    if (frameworks.some((index) => FRAMEWORKS[index].files.some((pattern) => pattern.test(relative)))) return true;
    if (path.posix.dirname(dir) === dir) return false;
  }
}
