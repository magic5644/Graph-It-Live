import { formatDate } from "@ws/core";

export function button(label: string): string {
  return `${label} (${formatDate(0)})`;
}
