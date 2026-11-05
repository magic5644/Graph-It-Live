/**
 * The one loading state of every webview view: the Graph-It-Live logo, a message and,
 * when the percentage is known, a progress bar.
 *
 * The logo is inlined in the bundle (no asset to load, no CSP change).
 */
import React, { useId } from "react";
import logoSvg from "../../../media/graph-it-live-logo.svg" with { type: "text" };

const DEFAULT_MESSAGE = "Loading…";

/** The logo markup with its ids (gradients, star symbol) prefixed: two instances must not share an id. */
function logoMarkup(prefix: string): string {
  return logoSvg.replaceAll("gil-", `${prefix}-`).replace("<svg ", '<svg width="100%" height="100%" ');
}

export interface LoadingStateProps {
  message?: string;
  /** 0-100: shows a progress bar. */
  percent?: number;
  /** Extra content under the message (a tip, a button). */
  children?: React.ReactNode;
}

export function LoadingState({ message, percent, children }: Readonly<LoadingStateProps>): React.ReactElement {
  // useId holds characters (":", "«") that break `url(#id)` references.
  const prefix = `gil${useId().replaceAll(/[^\w-]/g, "")}`;
  // `||`: an empty message from the extension carries nothing to read either.
  const text = message || DEFAULT_MESSAGE;
  const label = percent === undefined ? text : `${text} (${percent}%)`;
  return (
    <output
      aria-live="polite"
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 12,
        height: "100%",
        padding: 20,
        boxSizing: "border-box",
        textAlign: "center",
        color: "var(--vscode-descriptionForeground)",
        fontFamily: "var(--vscode-font-family)",
        fontSize: 13,
      }}
    >
      <span
        aria-hidden="true"
        data-testid="graph-it-live-logo"
        style={{ display: "block", width: 64, height: 64 }}
        dangerouslySetInnerHTML={{ __html: logoMarkup(prefix) }}
      />
      <span style={{ maxWidth: 400 }}>{label}</span>
      {percent !== undefined && (
        <progress max={100} value={percent} aria-label={label} style={{ width: 200, accentColor: "var(--vscode-progressBar-background)" }} />
      )}
      {children}
    </output>
  );
}
