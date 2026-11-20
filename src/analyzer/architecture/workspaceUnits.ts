/**
 * The units of a workspace, as every surface draws them (#776): the declared elements of
 * graphit.architecture.json when it declares any, else the detected projects, with the rules
 * attached to the unit edges they check. The only code that builds units.
 *
 * CRITICAL ARCHITECTURE RULE: This module is completely VS Code agnostic!
 */

import type { ArchitectureUnits } from "../../shared/architecture-model";
import type { ArchitectureGraph } from "./ArchitectureGraphBuilder";
import type { ArchitectureConfig, BaselineEntry, WorkspaceArchitectureCheck } from "./architectureRules";
import type { UnitAssignment } from "./architectureUnits";

/** What a path-mode build keeps to answer a folder level later. */
export interface UnitSource {
  graph: ArchitectureGraph;
  units: ArchitectureUnits;
  assignment: UnitAssignment;
}

export interface WorkspaceUnitsOptions {
  /** Workspace-relative config; false reads none (detected projects only). Default graphit.architecture.json; a missing default file means no config. */
  config?: string | false;
  /** As ArchitectureRulesFileNames.baseline. */
  baseline?: string | false;
}

export interface WorkspaceUnits extends UnitSource {
  /** The detected (manifest) assignment: `unit`/`role` selectors and noCycles "units" read it. */
  detected: UnitAssignment;
  /** The rule check when a config was read (also with no elements: its configWarnings still apply). */
  check?: WorkspaceArchitectureCheck;
}

/** Reads the config and baseline, then calls workspaceUnits. Throws ArchitectureRulesFileError on a refused config. */
export async function loadWorkspaceUnits(_graph: ArchitectureGraph, _workspaceRoot: string, _options?: WorkspaceUnitsOptions): Promise<WorkspaceUnits> {
  throw new Error("not implemented");
}

/** The same from a config held in memory (init's merged config, review's config). */
export function workspaceUnits(
  _graph: ArchitectureGraph,
  _workspaceRoot: string,
  _config?: ArchitectureConfig,
  _baseline?: readonly BaselineEntry[],
  _files?: { configFile: string; baselineFile?: string },
): WorkspaceUnits {
  throw new Error("not implemented");
}
