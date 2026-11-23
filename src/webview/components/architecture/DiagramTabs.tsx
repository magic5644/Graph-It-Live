/**
 * The diagram tabs of the Architecture mode (`Units | Folder | Matrix | Flow | Sequence`, the CLI
 * `graph-it diagram --view` names), the Follow cursor toggle and the Units cap banner.
 */
import React from "react";
import { DIAGRAM_TABS, type ArchitectureSummaryMessage, type DiagramShownCommand, type DiagramTab } from "../../../shared/architecture-types";

const TAB_LABELS: Record<DiagramTab, string> = { units: "Units", folder: "Folder", matrix: "Matrix", flow: "Flow", sequence: "Sequence" };
/** Shorter text shown on a tab, its full name kept as accessible name and tooltip: five tabs fit one row of a 229px-wide view (#426). */
const TAB_TEXT: Partial<Record<DiagramTab, string>> = { sequence: "Seq" };

/** The focus ring of every diagram control: the theme's focus border, keyboard focus only. */
export const DIAGRAM_FOCUS_CLASS = "diagram-focus";
const DIAGRAM_CSS = `.${DIAGRAM_FOCUS_CLASS}:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.${DIAGRAM_FOCUS_CLASS}[aria-disabled="true"] { opacity: 0.5; cursor: default; }`;

export interface DiagramTabState {
  hasWorkspace: boolean;
  /** A folder level was entered: the Folder tab returns to it. */
  folderEntered: boolean;
}

/** Why a tab cannot be selected now, or undefined when it can: the tooltip of the disabled tab. */
export function disabledReason(tab: DiagramTab, { hasWorkspace, folderEntered }: DiagramTabState): string | undefined {
  // Flow and Sequence draw the symbol at the cursor when nothing is drawn (#825).
  if (tab === "flow" || tab === "sequence") return undefined;
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
  const moveFocus = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    const step = ARROW_STEP[event.key];
    if (step === undefined) return;
    event.preventDefault();
    const tabs = Array.from(event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="tab"]') ?? []);
    const at = tabs.indexOf(event.currentTarget);
    tabs[(at + step + tabs.length) % tabs.length]?.focus();
  };
  return (
    <div role="tablist" aria-label="Diagram tabs" style={{ display: "inline-flex" }}>
      <style>{DIAGRAM_CSS}</style>
      {DIAGRAM_TABS.map((name) => {
        const reason = disabledReason(name, state);
        return (
          <button
            key={name} type="button" role="tab" data-tab={name} className={DIAGRAM_FOCUS_CLASS}
            aria-selected={tab === name} aria-disabled={reason ? true : undefined} title={reason ?? (TAB_TEXT[name] && TAB_LABELS[name])}
            aria-label={TAB_TEXT[name] && TAB_LABELS[name]}
            tabIndex={tab === name ? 0 : -1} onKeyDown={moveFocus}
            onClick={() => { if (!reason && name !== tab) onTab(name); }}
            // Compact: five tabs and the find box share one row on a 229px-wide view (#426), Linux fonts included.
            style={{ fontWeight: tab === name ? 600 : undefined, font: "inherit", fontSize: 11, padding: "1px", borderWidth: 1 }}
          >
            {TAB_TEXT[name] ?? TAB_LABELS[name]}
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

/** Members of the units level's largest cycle when it is past the diagram cap (never drawn node-link), else 0. */
export function largeUnitCycle(summary: Pick<ArchitectureSummaryMessage, "unitCap" | "units">): number {
  const largest = Math.max(0, ...(summary.units?.cycleUnits ?? []).map((members) => members.length));
  return summary.unitCap && largest > summary.unitCap.cap ? largest : 0;
}

/** Units level past the diagram cap: says how many are drawn (or that a cycle is too large to draw) and offers the complete views. */
export function UnitCapBanner({ unitCap, cycle, onMatrix, onList }: Readonly<{
  unitCap: NonNullable<ArchitectureSummaryMessage["unitCap"]>;
  /** Members of a cycle past the cap (largeUnitCycle), 0 when none. */
  cycle: number;
  onMatrix: () => void;
  onList: () => void;
}>) {
  return (
    <output data-unit-cap style={{ display: "block", fontSize: 12, padding: "2px 10px" }}>
      {cycle > 0 && `This level has a cycle of ${cycle} members: drawn as a matrix. `}
      Showing {unitCap.drawnUnits.length} of {unitCap.totalUnits} units.{" "}
      <button type="button" className={DIAGRAM_FOCUS_CLASS} onClick={onMatrix}>Open matrix</button>{" "}
      <button type="button" className={DIAGRAM_FOCUS_CLASS} onClick={onList}>Show list</button>
    </output>
  );
}

const textOf = (element: Element | null | undefined) => element?.textContent?.trim() || undefined;

/** What the Architecture mode shows, read from its DOM (E2E observability): tabs, breadcrumb, cap banner, focus, Flow buttons. */
export function diagramShownReport(root: ParentNode = document): DiagramShownCommand {
  const tabs = Array.from(root.querySelectorAll<HTMLElement>('[role="tab"][data-tab]'), (element) => ({
    tab: element.dataset.tab as DiagramTab,
    selected: element.getAttribute("aria-selected") === "true",
    ...(element.getAttribute("aria-disabled") === "true" ? { disabled: element.title } : {}),
  }));
  // Both breadcrumbs (Flow's list, the levels' spans) separate their segments with "›".
  const crumbs = (root.querySelector('nav[aria-label="Diagram scope"]')?.textContent ?? "").split("›").map((text) => text.replace("×", "").trim()).filter(Boolean);
  const active = document.activeElement;
  const requestId = root.querySelector<HTMLElement>("img[data-request-id]")?.dataset.requestId;
  return {
    command: "diagramShown",
    tabs,
    crumbs,
    banner: textOf(root.querySelector("output[data-unit-cap]")),
    focused: active && active !== document.body ? active.getAttribute("aria-label") ?? (active as HTMLElement).dataset?.tab ?? textOf(active) : undefined,
    flowRequestId: requestId === undefined ? undefined : Number(requestId),
    flowButtons: Array.from(root.querySelectorAll("button[data-flow-node], button[data-flow-edge]"), (element) => element.getAttribute("aria-label") ?? ""),
    flowLine: textOf(root.querySelector("output[data-flow-line]")),
    flowBusy: root.querySelector('[data-testid="flow-diagram"][aria-busy="true"]') !== null,
  };
}
