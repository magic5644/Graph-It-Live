import type { ArchitectureUnit } from "./architecture-model";

type NamedUnit = Pick<ArchitectureUnit, "key" | "name">;

/** The one name every renderer (text, markdown, JSON, TOON, SVG, HTML, MCP, VS Code) shows for a unit (#774). */
export function unitDisplayName(unit: NamedUnit): string {
  return unit.name;
}

/** The unit folder, shown as a secondary label only when it differs from the display name. */
export function unitSecondaryName(unit: NamedUnit): string | undefined {
  return unit.key === unit.name ? undefined : unit.key;
}
