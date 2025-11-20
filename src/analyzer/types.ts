export interface Dependency {
  path: string;
  type: 'import' | 'require' | 'export' | 'dynamic';
  line: number;
  module: string; // Original module specifier
}

export interface SpiderConfig {
  rootDir: string;
  tsConfigPath?: string;
  maxDepth?: number;
  excludeNodeModules?: boolean;
}

export interface ParsedImport {
  module: string;
  type: 'import' | 'require' | 'export' | 'dynamic';
  line: number;
}
