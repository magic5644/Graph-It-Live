import { ID_PREFIX } from "@ws/types";

export function formatDate(time: number): string {
  return `${ID_PREFIX}${new Date(time).toISOString()}`;
}
