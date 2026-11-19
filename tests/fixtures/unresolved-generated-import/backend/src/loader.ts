import { performance } from "node:perf_hooks";
import debounce from "lodash/debounce";
import { resolvers } from "./resolvers.generated";

export const reload = debounce(() => performance.now(), 100);

export async function loadResolvers(): Promise<Record<string, unknown>> {
  return await resolvers();
}
