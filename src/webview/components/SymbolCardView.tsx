import React from "react";
import { SymbolDependency, SymbolInfo } from "../../shared/types";
import { getFileName } from "../utils/nodeUtils";

interface SymbolCardViewProps {
  filePath: string;
  symbols: SymbolInfo[];
  dependencies: SymbolDependency[];
  referencingFiles: string[];
  showTypes: boolean;
  filterUnused?: boolean;
  onShowTypesChange: (show: boolean) => void;
  onSymbolClick: (symbolId: string, line: number) => void;
  onNavigateToFile: (filePath: string, mode: "card" | "file") => void;
  onBack: () => void;
  onSwitchToGraphView: () => void;
  onRefresh?: () => void;
  onToggleFilterUnused?: () => void;
}

// Symbol category colors matching VS Code icons
const CATEGORY_COLORS: Record<string, { bg: string; text: string }> = {
  function: { bg: "#4ec9b0", text: "#000" },
  class: { bg: "#4fc1ff", text: "#000" },
  variable: { bg: "#9cdcfe", text: "#000" },
  interface: { bg: "#b5cea8", text: "#000" },
  type: { bg: "#ce9178", text: "#000" },
  other: { bg: "#c586c0", text: "#000" },
};

const CATEGORY_ICONS: Record<string, string> = {
  function: "ƒ",
  class: "C",
  variable: "v",
  interface: "I",
  type: "T",
  other: "?",
};

const SymbolCardView: React.FC<SymbolCardViewProps> = ({
  filePath,
  symbols,
  dependencies,
  referencingFiles,
  showTypes,
  filterUnused = false,
  onShowTypesChange,
  onSymbolClick,
  onNavigateToFile,
  onBack,
  onSwitchToGraphView,
  onRefresh,
  onToggleFilterUnused,
}) => {
  // Filter symbols based on showTypes
  const filteredSymbols = showTypes
    ? symbols
    : symbols.filter(
        (s) => s.category !== "type" && s.category !== "interface",
      );

  // Group symbols: top-level and their children
  const topLevelSymbols = filteredSymbols.filter((s) => !s.parentSymbolId);
  const childrenByParent = new Map<string, SymbolInfo[]>();

  filteredSymbols.forEach((s) => {
    if (s.parentSymbolId) {
      const children = childrenByParent.get(s.parentSymbolId) || [];
      children.push(s);
      childrenByParent.set(s.parentSymbolId, children);
    }
  });

  // Get dependencies for a symbol, grouped by target file
  const getExternalDeps = (
    symbolId: string,
  ): Map<string, SymbolDependency[]> => {
    const deps = dependencies.filter((d) => d.sourceSymbolId === symbolId);
    const byFile = new Map<string, SymbolDependency[]>();
    deps.forEach((d) => {
      if (!d.targetFilePath || d.targetFilePath === filePath) return;
      const existing = byFile.get(d.targetFilePath) || [];
      existing.push(d);
      byFile.set(d.targetFilePath, existing);
    });
    return byFile;
  };

  const fileName = getFileName(filePath);

  return (
    <div
      style={{
        width: "100%",
        height: "100vh",
        overflow: "auto",
        background: "var(--vscode-editor-background)",
        padding: 16,
        boxSizing: "border-box",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          marginBottom: 16,
          paddingBottom: 12,
          borderBottom: "1px solid var(--vscode-widget-border)",
          flexWrap: "wrap",
        }}
      >
        <button
          onClick={onBack}
          title="Switch to File View"
          style={{
            background: "var(--vscode-button-secondaryBackground)",
            color: "var(--vscode-button-secondaryForeground)",
            border: "none",
            borderRadius: 4,
            padding: "6px 12px",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          📁 File View
        </button>
        <button
          onClick={onSwitchToGraphView}
          title="Switch to Graph View"
          style={{
            background: "var(--vscode-button-secondaryBackground)",
            color: "var(--vscode-button-secondaryForeground)",
            border: "none",
            borderRadius: 4,
            padding: "6px 12px",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          📊 Graph View
        </button>
        <div style={{ flex: 1, minWidth: 150 }}>
          <div
            style={{
              fontSize: 14,
              fontWeight: "bold",
              color: "var(--vscode-foreground)",
            }}
          >
            ✨ Symbol View
          </div>
          <div
            style={{
              fontSize: 12,
              color: "var(--vscode-descriptionForeground)",
              marginTop: 2,
            }}
          >
            {fileName} — {filteredSymbols.length} symbols
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {onRefresh && (
            <button
              onClick={onRefresh}
              title="Refresh symbol view"
              aria-label="Refresh"
              style={{
                background: "var(--vscode-button-secondaryBackground)",
                color: "var(--vscode-button-secondaryForeground)",
                border: "none",
                borderRadius: 4,
                padding: "6px 8px",
                cursor: "pointer",
                fontSize: 14,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              ↻
            </button>
          )}
          {onToggleFilterUnused && (
            <button
              onClick={onToggleFilterUnused}
              title={
                filterUnused
                  ? "Show all dependencies (including unused)"
                  : "Hide unused dependencies"
              }
              aria-label={
                filterUnused
                  ? "Show all dependencies"
                  : "Hide unused dependencies"
              }
              style={{
                background: filterUnused
                  ? "var(--vscode-button-background)"
                  : "var(--vscode-button-secondaryBackground)",
                color: filterUnused
                  ? "var(--vscode-button-foreground)"
                  : "var(--vscode-button-secondaryForeground)",
                border: "none",
                borderRadius: 4,
                padding: "6px 12px",
                cursor: "pointer",
                fontSize: 11,
                fontWeight: 500,
                whiteSpace: "nowrap",
              }}
            >
              {filterUnused ? "Used Only" : "Show All"}
            </button>
          )}
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: 11,
              cursor: "pointer",
            }}
          >
            <input
              type="checkbox"
              checked={showTypes}
              onChange={(e) => onShowTypesChange(e.target.checked)}
            />{" "}
            Show types/interfaces
          </label>
        </div>
      </div>

      {/* Legend */}
      <div
        style={{
          display: "flex",
          gap: 12,
          marginBottom: 16,
          fontSize: 11,
          flexWrap: "wrap",
        }}
      >
        {Object.entries(CATEGORY_COLORS).map(([category, colors]) => {
          if (!showTypes && (category === "type" || category === "interface"))
            return null;
          return (
            <div
              key={category}
              style={{ display: "flex", alignItems: "center", gap: 4 }}
            >
              <span
                style={{
                  width: 16,
                  height: 16,
                  borderRadius: 3,
                  background: colors.bg,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 10,
                  fontWeight: "bold",
                  color: colors.text,
                }}
              >
                {CATEGORY_ICONS[category]}
              </span>
              <span style={{ textTransform: "capitalize" }}>{category}</span>
            </div>
          );
        })}
      </div>

      {/* Main content: 2 columns */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 2fr) minmax(250px, 1fr)",
          gap: 16,
        }}
      >
        {/* Left: Symbol Cards */}
        <div>
          <h3
            style={{
              fontSize: 12,
              margin: "0 0 12px 0",
              color: "var(--vscode-foreground)",
              textTransform: "uppercase",
              letterSpacing: 0.5,
            }}
          >
            Exported Symbols
          </h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {topLevelSymbols.map((symbol) => (
              <SymbolCard
                key={symbol.id}
                symbol={symbol}
                members={childrenByParent.get(symbol.id) || []}
                externalDeps={getExternalDeps(symbol.id)}
                onSymbolClick={onSymbolClick}
                onNavigateToFile={onNavigateToFile}
              />
            ))}
            {topLevelSymbols.length === 0 && (
              <div
                style={{
                  padding: 20,
                  textAlign: "center",
                  color: "var(--vscode-descriptionForeground)",
                  fontSize: 12,
                }}
              >
                No exported symbols found
              </div>
            )}
          </div>
        </div>

        {/* Right: Imported By */}
        <div>
          <h3
            style={{
              fontSize: 12,
              margin: "0 0 12px 0",
              color: "var(--vscode-foreground)",
              textTransform: "uppercase",
              letterSpacing: 0.5,
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            ◀ Imported By{" "}
            <span
              style={{
                background: "var(--vscode-badge-background)",
                color: "var(--vscode-badge-foreground)",
                padding: "2px 6px",
                borderRadius: 10,
                fontSize: 10,
              }}
            >
              {referencingFiles.length}
            </span>
          </h3>
          <div
            style={{
              background: "var(--vscode-editor-inactiveSelectionBackground)",
              border: "1px solid var(--vscode-widget-border)",
              borderRadius: 6,
              overflow: "hidden",
            }}
          >
            {referencingFiles.length === 0 ? (
              <div
                style={{
                  padding: 16,
                  textAlign: "center",
                  color: "var(--vscode-descriptionForeground)",
                  fontSize: 11,
                }}
              >
                No files import this module
              </div>
            ) : (
              <div style={{ maxHeight: 400, overflow: "auto" }}>
                {referencingFiles.map((file) => (
                  <ImporterRow
                    key={file}
                    filePath={file}
                    onNavigateToFile={onNavigateToFile}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};;

// Component for importer row
interface ImporterRowProps {
  filePath: string;
  onNavigateToFile: (filePath: string, mode: "card" | "file") => void;
}

const ImporterRow: React.FC<ImporterRowProps> = ({
  filePath,
  onNavigateToFile,
}) => {
  const [hovered, setHovered] = React.useState(false);
  const fileName = getFileName(filePath);

  return (
    <div //NOSONAR
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "8px 12px",
        borderBottom: "1px solid var(--vscode-widget-border)",
        background: hovered
          ? "var(--vscode-list-hoverBackground)"
          : "transparent",
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <span style={{ fontSize: 14 }}>📄</span>
      <span
        style={{
          flex: 1,
          fontSize: 12,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={filePath}
      >
        {fileName}
      </span>
      <button
        onClick={() => onNavigateToFile(filePath, "card")}
        style={{
          background: "var(--vscode-button-secondaryBackground)",
          color: "var(--vscode-button-secondaryForeground)",
          border: "none",
          borderRadius: 3,
          padding: "2px 6px",
          fontSize: 10,
          cursor: "pointer",
        }}
        title="View symbols"
      >
        ✨
      </button>
      <button
        onClick={() => onNavigateToFile(filePath, "file")}
        style={{
          background: "var(--vscode-button-secondaryBackground)",
          color: "var(--vscode-button-secondaryForeground)",
          border: "none",
          borderRadius: 3,
          padding: "2px 6px",
          fontSize: 10,
          cursor: "pointer",
        }}
        title="View dependencies"
      >
        📁
      </button>
    </div>
  );
};

// Component for symbol cards
interface SymbolCardProps {
  symbol: SymbolInfo;
  members: SymbolInfo[];
  externalDeps: Map<string, SymbolDependency[]>;
  onSymbolClick: (symbolId: string, line: number) => void;
  onNavigateToFile: (filePath: string, mode: "card" | "file") => void;
}

const SymbolCard: React.FC<SymbolCardProps> = ({
  symbol,
  members,
  externalDeps,
  onSymbolClick,
  onNavigateToFile,
}) => {
  const colors = CATEGORY_COLORS[symbol.category] || CATEGORY_COLORS.other;
  const icon = CATEGORY_ICONS[symbol.category] || "?";

  const handleKeyDown = (e: React.KeyboardEvent, action: () => void) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      action();
    }
  };

  return (
    <div
      style={{
        background: "var(--vscode-editor-inactiveSelectionBackground)",
        border: "1px solid var(--vscode-widget-border)",
        borderRadius: 6,
        overflow: "hidden",
      }}
    >
      {/* Card Header */}
      <div //NOSONAR
        role="button"
        tabIndex={0}
        onClick={() => onSymbolClick(symbol.id, symbol.line)}
        onKeyDown={(e) =>
          handleKeyDown(e, () => onSymbolClick(symbol.id, symbol.line))
        }
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "10px 12px",
          background: colors.bg + "33",
          borderBottom: "1px solid var(--vscode-widget-border)",
          cursor: "pointer",
        }}
      >
        <span
          style={{
            width: 28,
            height: 28,
            borderRadius: 4,
            background: colors.bg,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 16,
            fontWeight: "bold",
            color: colors.text,
          }}
        >
          {icon}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontWeight: "bold",
              fontSize: 14,
              color: "var(--vscode-foreground)",
            }}
          >
            {symbol.name}
          </div>
          <div
            style={{
              fontSize: 10,
              color: "var(--vscode-descriptionForeground)",
            }}
          >
            Line {symbol.line} • {symbol.kind}
          </div>
        </div>
        {symbol.isExported && (
          <span
            style={{
              fontSize: 9,
              padding: "2px 6px",
              borderRadius: 3,
              background: "var(--vscode-badge-background)",
              color: "var(--vscode-badge-foreground)",
            }}
          >
            export
          </span>
        )}
      </div>

      {/* Members (for classes) */}
      {members.length > 0 && (
        <div style={{ padding: "8px 12px" }}>
          <div
            style={{
              fontSize: 10,
              color: "var(--vscode-descriptionForeground)",
              marginBottom: 6,
              textTransform: "uppercase",
              letterSpacing: 0.5,
            }}
          >
            Members ({members.length})
          </div>
          {members.map((member) => {
            const memberColors =
              CATEGORY_COLORS[member.category] || CATEGORY_COLORS.other;
            const memberIcon = CATEGORY_ICONS[member.category] || "?";
            const memberName = member.name.split(".").pop() || member.name;

            return (
              <div //NOSONAR
                key={member.id}
                role="button"
                tabIndex={0}
                onClick={() => onSymbolClick(member.id, member.line)}
                onKeyDown={(e) =>
                  handleKeyDown(e, () => onSymbolClick(member.id, member.line))
                }
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "4px 0",
                  cursor: "pointer",
                }}
              >
                <span
                  style={{
                    width: 16,
                    height: 16,
                    borderRadius: 3,
                    background: memberColors.bg,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 9,
                    fontWeight: "bold",
                    color: memberColors.text,
                  }}
                >
                  {memberIcon}
                </span>
                <span
                  style={{ fontSize: 12, color: "var(--vscode-foreground)" }}
                >
                  {memberName}
                </span>
                <span
                  style={{
                    fontSize: 10,
                    color: "var(--vscode-descriptionForeground)",
                    marginLeft: "auto",
                  }}
                >
                  :{member.line}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* Uses - clickable links grouped by file */}
      {externalDeps.size > 0 && (
        <div
          style={{
            padding: "8px 12px",
            borderTop: "1px solid var(--vscode-widget-border)",
            background: "var(--vscode-editor-background)",
          }}
        >
          <div
            style={{
              fontSize: 10,
              color: "var(--vscode-descriptionForeground)",
              marginBottom: 6,
              textTransform: "uppercase",
              letterSpacing: 0.5,
            }}
          >
            Uses (
            {Array.from(externalDeps.values()).reduce(
              (a, b) => a + b.length,
              0,
            )}
            )
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {Array.from(externalDeps.entries()).map(([targetFile, deps]) => (
              <DependencyLink
                key={targetFile}
                targetFile={targetFile}
                symbolNames={deps.map(
                  (d) => d.targetSymbolId.split(":").pop() || "",
                )}
                onNavigateToFile={onNavigateToFile}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

// Component for clickable dependency link
interface DependencyLinkProps {
  targetFile: string;
  symbolNames: string[];
  onNavigateToFile: (filePath: string, mode: "card" | "file") => void;
}

const DependencyLink: React.FC<DependencyLinkProps> = ({
  targetFile,
  symbolNames,
  onNavigateToFile,
}) => {
  const [hovered, setHovered] = React.useState(false);
  const targetFileName = getFileName(targetFile);

  return (
    <button
      onClick={() => onNavigateToFile(targetFile, "card")}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "4px 6px",
        borderRadius: 3,
        background: hovered
          ? "var(--vscode-textLink-foreground)22"
          : "var(--vscode-textLink-foreground)11",
        border: "none",
        cursor: "pointer",
        textAlign: "left",
        width: "100%",
      }}
      title={`Navigate to ${targetFile}`}
    >
      <span
        style={{ color: "var(--vscode-textLink-foreground)", fontSize: 12 }}
      >
        ↗
      </span>
      <span
        style={{
          fontSize: 11,
          color: "var(--vscode-textLink-foreground)",
          fontWeight: 500,
        }}
      >
        {targetFileName}
      </span>
      <span
        style={{
          fontSize: 10,
          color: "var(--vscode-descriptionForeground)",
          marginLeft: "auto",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          maxWidth: 150,
        }}
      >
        {symbolNames.join(", ")}
      </span>
    </button>
  );
};

export default SymbolCardView;
