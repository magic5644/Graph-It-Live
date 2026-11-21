/**
 * The diagram tabs of the Architecture mode (`Units | Folder | Matrix | Flow`, the CLI
 * `graph-it diagram --view` names), the Follow cursor toggle and the Units cap banner.
 */
import React from "react";
import { DIAGRAM_TABS, type ArchitectureSummaryMessage, type DiagramTab } from "../../../shared/architecture-types";

const TAB_LABELS: Record<DiagramTab, string> = { units: "Units", folder: "Folder", matrix: "Matrix", flow: "Flow" };

/** The focus ring of every diagram control: the theme's focus border, keyboard focus only. */
export const DIAGRAM_FOCUS_CLASS = "diagram-focus";
const DIAGRAM_CSS = `.${DIAGRAM_FOCUS_CLASS}:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.${DIAGRAM_FOCUS_CLASS}[aria-disabled="true"] { opacity: 0.5; cursor: default; }`;

export interface DiagramTabState {
  hasWorkspace: boolean;
  /** A folder level was entered: the Folder tab returns to it. */
  folderEntered: boolean;
  /** A flow was drawn or asked for. */
  flowAvailable: boolean;
}

/** Why a tab cannot be selected now, or undefined when it can: the tooltip of the disabled tab. */
export function disabledReason(tab: DiagramTab, { hasWorkspace, folderEntered, flowAvailable }: DiagramTabState): string | undefined {
  if (tab === "flow") return flowAvailable ? undefined : "Right-click a function in the editor and run Show Flow Diagram";
  if (!hasWorkspace) return `Open a folder to see the ${TAB_LABELS[tab]} diagram`;
  if (tab === "folder" && !folderEntered) return "Double-click a unit, or right-click a folder in the Explorer, to see its Folder diagram";
  return undefined;
}

/** Keyboard focus back to the selected tab (Escape from a diagram). */
export function focusSelectedTab(): void {
  document.querySelector<HTMLElement>('[role="tablist"][aria-label="Diagram tabs"] [aria-selected="true"]')?.focus();
}

const ARROW_STEP: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1 };

/** `role="tablist"`: a disabled tab stays focusable (aria-disabled) so its tooltip says why; arrows move between tabs. */
export function DiagramTabs({ tab, state, onTab }: Readonly<{ tab: DiagramTab; state: DiagramTabState; onTab: (tab: DiagramTab) => void }>) {
  const moveFocus = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = ARROW_STEP[event.key];
    if (step === undefined) return;
    event.preventDefault();
    const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'));
    const at = tabs.indexOf(document.activeElement as HTMLElement);
    tabs[(at + step + tabs.length) % tabs.length]?.focus();
  };
  return (
    <div role="tablist" aria-label="Diagram tabs" onKeyDown={moveFocus} style={{ display: "inline-flex", gap: 2 }}>
      <style>{DIAGRAM_CSS}</style>
      {DIAGRAM_TABS.map((name) => {
        const reason = disabledReason(name, state);
        return (
          <button
            key={name} type="button" role="tab" data-tab={name} className={DIAGRAM_FOCUS_CLASS}
            aria-selected={tab === name} aria-disabled={reason ? true : undefined} title={reason}
            tabIndex={tab === name ? 0 : -1}
            onClick={() => { if (!reason && name !== tab) onTab(name); }}
            style={{ fontWeight: tab === name ? 600 : undefined }}
          >
            {TAB_LABELS[name]}
          </button>
        );
      })}
    </div>
  );
}

/** Follow cursor: off = the diagram stays pinned on its scope (the default). */
export function FollowToggle({ follow, onFollow }: Readonly<{ follow: boolean; onFollow: (enabled: boolean) => void }>) {
  return (
    <button
      type="button" data-follow className={DIAGRAM_FOCUS_CLASS} aria-pressed={follow} onClick={() => onFollow(!follow)}
      title="Follow cursor: redraw the diagram for the symbol or folder of the cursor"
    >
      Follow cursor
    </button>
  );
}

/** Units level past the diagram cap: says how many are drawn and offers the complete views. */
export function UnitCapBanner({ unitCap, onMatrix, onList }: Readonly<{
  unitCap: NonNullable<ArchitectureSummaryMessage["unitCap"]>;
  onMatrix: () => void;
  onList: () => void;
}>) {
  return (
    <output data-unit-cap style={{ display: "block", fontSize: 12, padding: "2px 10px" }}>
      Showing {unitCap.drawnUnits.length} of {unitCap.totalUnits} units.{" "}
      <button type="button" className={DIAGRAM_FOCUS_CLASS} onClick={onMatrix}>Open matrix</button>{" "}
      <button type="button" className={DIAGRAM_FOCUS_CLASS} onClick={onList}>Show list</button>
    </output>
  );
}
