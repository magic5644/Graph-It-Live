import type { ArchitectureUnit } from "./architecture-model";

type NamedUnit = Pick<ArchitectureUnit, "key" | "name">;
type FolderUnit = Pick<ArchitectureUnit, "name" | "folder">;

/** The one name every renderer (text, markdown, JSON, TOON, SVG, HTML, MCP, VS Code) shows for a unit (#774). */
export function unitDisplayName(unit: NamedUnit): string {
  return unit.name;
}

/** The unit folder, shown as a secondary label only when it is set and differs from the display name. */
export function unitSecondaryName(unit: FolderUnit): string | undefined {
  return unit.folder === "" || unit.folder === unit.name ? undefined : unit.folder;
}
