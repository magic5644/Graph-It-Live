/**
 * The Flow diagram's scope, `workspace > folder > file > symbol`: every segment but the last
 * re-scopes the diagram; the last one is where the view is.
 */
import React from "react";
import type { DiagramCrumb } from "../../../shared/architecture-types";
import { DIAGRAM_FOCUS_CLASS } from "./DiagramTabs";

const crumbStyle: React.CSSProperties = {
  background: "none", border: "none", padding: 0, cursor: "pointer", font: "inherit", color: "var(--vscode-textLink-foreground)",
};

export function DiagramBreadcrumb({ crumbs, onCrumb }: Readonly<{ crumbs: readonly DiagramCrumb[]; onCrumb: (crumb: DiagramCrumb) => void }>) {
  if (crumbs.length === 0) return null;
  return (
    <nav aria-label="Diagram scope" style={{ fontSize: 12 }}>
      <ol style={{ display: "inline", listStyle: "none", margin: 0, padding: 0 }}>
        {crumbs.map((crumb, index) => {
          const current = index === crumbs.length - 1;
          return (
            <li key={`${crumb.kind}:${crumb.key ?? crumb.label}`} style={{ display: "inline" }}>
              {index > 0 && <span aria-hidden="true"> › </span>}
              {current
                ? <span aria-current="page" style={{ fontWeight: 600 }}>{crumb.label}</span>
                : (
                  <button type="button" className={DIAGRAM_FOCUS_CLASS} data-crumb={crumb.kind} style={crumbStyle} onClick={() => onCrumb(crumb)}>
                    {crumb.label}
                  </button>
                )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
