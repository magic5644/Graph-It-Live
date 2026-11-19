import { loadResolvers } from "./loader";

export async function start(): Promise<number> {
  return Object.keys(await loadResolvers()).length;
}
