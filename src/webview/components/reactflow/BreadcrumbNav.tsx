import React from 'react';
import { normalizePath } from '../../utils/path';

export interface BreadcrumbSegment {
    label: string;
    onClick?: () => void;
}

export interface BreadcrumbNavProps {
    /** Current file path being analyzed */
    filePath: string;
    /** Workspace root path for relative path calculation */
    workspaceRoot?: string;
    /** Callback when "Back to Project" is clicked */
    onBackToProject: () => void;
    /** Current view mode */
    mode: 'file' | 'symbol';
}

/**
 * BreadcrumbNav component displays hierarchical navigation
 * showing Project > Folder > filename.ts
 * 
 * Requirements:
 * - FR-006: Breadcrumb navigation showing `Project > Folder > filename.ts`
 * - SC-008: Allow users to return to file view within 1 click
 */
export const BreadcrumbNav: React.FC<BreadcrumbNavProps> = ({
    filePath,
    workspaceRoot,
    onBackToProject,
    mode,
}) => {
    // Parse file path into segments
    const segments = React.useMemo<BreadcrumbSegment[]>(() => {
        const normalizedPath = normalizePath(filePath);
        const normalizedRoot = workspaceRoot ? normalizePath(workspaceRoot) : null;

        // Calculate relative path if workspace root is available
        let displayPath = normalizedPath;
        if (normalizedRoot && normalizedPath.startsWith(normalizedRoot)) {
            displayPath = normalizedPath.substring(normalizedRoot.length);
            if (displayPath.startsWith('/')) {
                displayPath = displayPath.substring(1);
            }
        }

        const parts = displayPath.split('/').filter(Boolean);
        const result: BreadcrumbSegment[] = [];

        // Add "Project" root segment (clickable if in symbol mode)
        result.push({
            label: 'Project',
            onClick: mode === 'symbol' ? onBackToProject : undefined,
        });

        // Add folder segments (not clickable)
        for (let i = 0; i < parts.length - 1; i++) {
            result.push({
                label: parts[i],
                onClick: undefined, // Folders are not clickable
            });
        }

        // Add filename segment (always last, not clickable)
        if (parts.length > 0) {
            result.push({
                label: parts[parts.length - 1],
                onClick: undefined,
            });
        }

        return result;
    }, [filePath, workspaceRoot, mode, onBackToProject]);

    return (
        <nav
            style={{
                display: 'flex',
                alignItems: 'center',
                padding: '8px 12px',
                background: 'var(--vscode-editor-background)',
                borderBottom: '1px solid var(--vscode-widget-border)',
                fontSize: '12px',
                color: 'var(--vscode-descriptionForeground)',
                gap: '4px',
                flexWrap: 'wrap',
            }}
            aria-label="Breadcrumb navigation"
        >
            {segments.map((segment) => (
                <React.Fragment key={segment.label}>
                    {segments.indexOf(segment) > 0 && (
                        <span
                            style={{
                                color: 'var(--vscode-descriptionForeground)',
                                opacity: 0.5,
                            }}
                            aria-hidden="true"
                        >
                            {'>'}
                        </span>
                    )}
                    {segment.onClick ? (
                        <button
                            onClick={segment.onClick}
                            style={{
                                background: 'none',
                                border: 'none',
                                color: 'var(--vscode-textLink-foreground)',
                                cursor: 'pointer',
                                padding: '2px 4px',
                                borderRadius: '2px',
                                textDecoration: 'none',
                                fontSize: 'inherit',
                            }}
                            onMouseEnter={(e) => {
                                e.currentTarget.style.textDecoration = 'underline';
                                e.currentTarget.style.background = 'var(--vscode-list-hoverBackground)';
                            }}
                            onMouseLeave={(e) => {
                                e.currentTarget.style.textDecoration = 'none';
                                e.currentTarget.style.background = 'none';
                            }}
                            title={`Return to ${segment.label}`}
                        >
                            {segment.label}
                        </button>
                    ) : (
                        <span
                            style={{
                                color: segments.indexOf(segment) === segments.length - 1
                                    ? 'var(--vscode-foreground)'
                                    : 'var(--vscode-descriptionForeground)',
                                fontWeight: segments.indexOf(segment) === segments.length - 1 ? 600 : 400,
                                padding: '2px 4px',
                            }}
                        >
                            {segment.label}
                        </span>
                    )}
                </React.Fragment>
            ))}
        </nav>
    );
};
