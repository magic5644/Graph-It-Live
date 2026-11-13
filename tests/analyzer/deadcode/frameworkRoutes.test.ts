import { describe, expect, it } from "vitest";
import { isFrameworkRoute, packageFrameworks } from "@/analyzer/deadcode/frameworkRoutes";

const pkg = (deps: Record<string, string>, field = "dependencies"): string => JSON.stringify({ name: "x", [field]: deps });
const routes = (manifest: string, files: string[]): string[] => {
  const byPackage = new Map([["/repo/apps/web", packageFrameworks(manifest)]]);
  return files.filter((file) => isFrameworkRoute(`/repo/apps/web/${file}`, byPackage));
};

describe("packageFrameworks (#728)", () => {
  it("reads every dependency field", () => {
    for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      expect(packageFrameworks(pkg({ next: "15" }, field)), field).toHaveLength(1);
    }
  });

  it("finds nothing in a package without a framework, an unparsable or a non-object manifest", () => {
    expect(packageFrameworks(pkg({ react: "19" }))).toEqual([]);
    expect(packageFrameworks("{ not json")).toEqual([]);
    expect(packageFrameworks("[]")).toEqual([]);
    expect(packageFrameworks("null")).toEqual([]);
    expect(packageFrameworks(JSON.stringify({ dependencies: "next" }))).toEqual([]);
  });
});

describe("isFrameworkRoute (#728)", () => {
  it.each([
    ["next", { next: "15" }, [
      "app/page.tsx", "src/app/(group)/settings/[id]/page.tsx", "app/api/auth/route.ts", "app/layout.tsx", "app/sitemap.ts",
      "pages/index.tsx", "pages/api/trpc/[trpc].ts", "src/pages/_app.tsx", "middleware.ts", "src/instrumentation.ts",
    ], ["app/components/Button.tsx", "lib/route.ts", "app/api/auth/helpers.ts", "src/middleware/auth.ts"]],
    ["SvelteKit", { "@sveltejs/kit": "2" }, [
      "src/routes/+page.svelte", "src/routes/blog/[slug]/+page.server.ts", "src/routes/api/+server.ts", "src/routes/+layout@.svelte",
      "src/hooks.server.ts", "src/params/integer.ts", "src/service-worker.js", "src/env.ts",
    ], ["src/routes/blog/helpers.ts", "src/lib/db.ts", "routes/+page.ts"]],
    ["Remix", { "@remix-run/react": "2" }, ["app/routes/_index.tsx", "app/routes/blog.$slug.tsx", "app/root.tsx", "app/entry.server.tsx"], ["app/utils.ts", "routes/x.ts"]],
    ["React Router", { "@react-router/dev": "7" }, ["app/routes.ts", "app/routes/home.tsx"], ["app/lib/x.ts"]],
    ["Nuxt", { nuxt: "4" }, [
      "pages/index.vue", "app/pages/[id].vue", "components/AppHeader.vue", "composables/useUser.ts", "app/utils/format.ts",
      "server/api/users.get.ts", "server/middleware/log.ts", "app.vue", "app/error.vue", "plugins/sentry.client.ts", "shared/utils/x.ts",
    ], ["lib/db.ts", "server/db.ts", "types/index.ts"]],
    ["Astro", { astro: "5" }, ["src/pages/api/feed.ts", "src/middleware.ts", "src/content.config.ts"], ["src/lib/x.ts", "pages/x.ts"]],
    ["Expo Router", { "expo-router": "4" }, ["app/(tabs)/index.tsx", "src/app/_layout.tsx"], ["components/X.tsx"]],
    ["Gatsby", { gatsby: "5" }, ["src/pages/index.js", "src/api/hello.ts", "gatsby-node.js"], ["src/components/x.js"]],
    ["Storybook", { "@storybook/react": "8" }, ["src/Button.stories.tsx", "Button.stories.mjs"], ["src/Button.tsx", "src/stories.ts"]],
  ])("%s: matches its files only", (_name, deps, matched, unmatched) => {
    expect(routes(pkg(deps), [...matched, ...unmatched])).toEqual(matched);
  });

  it("matches nothing when the nearest package.json does not use the framework", () => {
    expect(routes(pkg({ react: "19" }), ["app/page.tsx", "pages/index.tsx", "src/routes/+page.svelte"])).toEqual([]);
  });

  it("reads each package.json above from its own folder, and nothing when there is none", () => {
    const byPackage = new Map<string, readonly number[]>([["/repo", packageFrameworks(pkg({ next: "15" }))], ["/repo/packages/ui", []]]);
    expect(isFrameworkRoute("/repo/app/page.tsx", byPackage)).toBe(true);
    expect(isFrameworkRoute("/repo/packages/ui/app/page.tsx", byPackage)).toBe(false);
    // A Nuxt layer with its own package.json, no nuxt dependency: the app's conventions reach it.
    const nuxt = new Map<string, readonly number[]>([["/site", packageFrameworks(pkg({ nuxt: "4" }))], ["/site/layers/chat", []]]);
    expect(isFrameworkRoute("/site/layers/chat/app/components/Chat.vue", nuxt)).toBe(true);
    expect(isFrameworkRoute("/site/layers/chat/lib/x.ts", nuxt)).toBe(false);
    expect(isFrameworkRoute("/elsewhere/app/page.tsx", byPackage)).toBe(false);
    expect(isFrameworkRoute("C:/repo/app/page.tsx", new Map([["C:/repo", packageFrameworks(pkg({ next: "15" }))]]))).toBe(true);
  });
});
