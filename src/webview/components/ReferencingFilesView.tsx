import React from 'react';

interface ReferencingFilesViewProps {
    targetFile: string;
    referencingFiles: string[];
    onFileClick: (path: string) => void;
    onClose: () => void;
}

const ReferencingFilesView: React.FC<ReferencingFilesViewProps> = ({
    targetFile,
    referencingFiles,
    onFileClick,
    onClose,
}) => {
    const targetFileName = targetFile.split(/[/\\]/).pop() || targetFile;

    return (
        <div style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'var(--vscode-editor-background)',
            zIndex: 100,
            display: 'flex',
            flexDirection: 'column',
        }}>
            {/* Header */}
            <div style={{
                padding: '12px 16px',
                borderBottom: '1px solid var(--vscode-widget-border)',
                display: 'flex',
                alignItems: 'center',
                gap: 12,
            }}>
                <button
                    onClick={onClose}
                    style={{
                        background: 'var(--vscode-button-secondaryBackground)',
                        color: 'var(--vscode-button-secondaryForeground)',
                        border: 'none',
                        borderRadius: 4,
                        padding: '6px 12px',
                        cursor: 'pointer',
                    }}
                >
                    ← Back
                </button>
                <div>
                    <div style={{ 
                        fontSize: 14, 
                        fontWeight: 'bold',
                        color: 'var(--vscode-foreground)',
                    }}>
                        ◀ Files importing this module
                    </div>
                    <div style={{ 
                        fontSize: 12, 
                        color: 'var(--vscode-descriptionForeground)',
                    }}>
                        {targetFileName}
                    </div>
                </div>
                <div style={{
                    marginLeft: 'auto',
                    background: 'var(--vscode-badge-background)',
                    color: 'var(--vscode-badge-foreground)',
                    padding: '4px 10px',
                    borderRadius: 10,
                    fontSize: 12,
                    fontWeight: 'bold',
                }}>
                    {referencingFiles.length}
                </div>
            </div>

            {/* File List */}
            <div style={{
                flex: 1,
                overflow: 'auto',
                padding: 16,
            }}>
                {referencingFiles.length === 0 ? (
                    <div style={{
                        textAlign: 'center',
                        padding: 40,
                        color: 'var(--vscode-descriptionForeground)',
                    }}>
                        No files import this module.
                    </div>
                ) : (
                    <div style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 4,
                    }}>
                        {referencingFiles.map(file => {
                            const fileName = file.split(/[/\\]/).pop() || file;
                            const dirPath = file.replace(/[/\\][^/\\]+$/, '');
                            const isTypeScript = fileName.endsWith('.ts') || fileName.endsWith('.tsx');
                            const isJavaScript = fileName.endsWith('.js') || fileName.endsWith('.jsx');
                            const isVue = fileName.endsWith('.vue');
                            
                            let iconColor = 'var(--vscode-foreground)';
                            if (isTypeScript) iconColor = '#3178c6';
                            else if (isJavaScript) iconColor = '#f7df1e';
                            else if (isVue) iconColor = '#41b883';

                            return (
                                <button
                                    key={file}
                                    type="button"
                                    onClick={() => onFileClick(file)}
                                    style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: 10,
                                        padding: '10px 12px',
                                        background: 'var(--vscode-list-hoverBackground)',
                                        borderRadius: 4,
                                        cursor: 'pointer',
                                        border: '1px solid transparent',
                                        width: '100%',
                                        textAlign: 'left',
                                        font: 'inherit',
                                    }}
                                    onMouseEnter={(e) => {
                                        e.currentTarget.style.background = 'var(--vscode-list-activeSelectionBackground)';
                                        e.currentTarget.style.borderColor = 'var(--vscode-focusBorder)';
                                    }}
                                    onMouseLeave={(e) => {
                                        e.currentTarget.style.background = 'var(--vscode-list-hoverBackground)';
                                        e.currentTarget.style.borderColor = 'transparent';
                                    }}
                                >
                                    <span style={{
                                        fontSize: 18,
                                        color: iconColor,
                                    }}>
                                        📄
                                    </span>
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                        <div style={{
                                            fontWeight: 500,
                                            fontSize: 13,
                                            color: 'var(--vscode-foreground)',
                                            overflow: 'hidden',
                                            textOverflow: 'ellipsis',
                                            whiteSpace: 'nowrap',
                                        }}>
                                            {fileName}
                                        </div>
                                        <div style={{
                                            fontSize: 11,
                                            color: 'var(--vscode-descriptionForeground)',
                                            overflow: 'hidden',
                                            textOverflow: 'ellipsis',
                                            whiteSpace: 'nowrap',
                                        }}>
                                            {dirPath}
                                        </div>
                                    </div>
                                    <span style={{
                                        fontSize: 16,
                                        color: 'var(--vscode-textLink-foreground)',
                                    }}>
                                        →
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );
};

export default ReferencingFilesView;
