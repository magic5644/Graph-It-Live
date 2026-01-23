// Extensions by language for type-safe language detection
export const TYPESCRIPT_EXTENSIONS = ['.ts', '.tsx'] as const;
export const JAVASCRIPT_EXTENSIONS = ['.js', '.jsx', '.mjs', '.cjs'] as const;
export const PYTHON_EXTENSIONS = ['.py', '.pyi'] as const;
export const RUST_EXTENSIONS = ['.rs'] as const;
export const VUE_EXTENSIONS = ['.vue'] as const;
export const SVELTE_EXTENSIONS = ['.svelte'] as const;
export const GRAPHQL_EXTENSIONS = ['.gql', '.graphql'] as const;
export const TOML_EXTENSIONS = ['.toml'] as const;

// Derived: All supported file extensions (deduced from language-specific constants)
export const SUPPORTED_FILE_EXTENSIONS = [
    ...TYPESCRIPT_EXTENSIONS,
    ...JAVASCRIPT_EXTENSIONS,
    ...VUE_EXTENSIONS,
    ...SVELTE_EXTENSIONS,
    ...GRAPHQL_EXTENSIONS,
    ...PYTHON_EXTENSIONS,
    ...RUST_EXTENSIONS,
    ...TOML_EXTENSIONS,
];

// Derived: Extensions supported for LSP-based symbol analysis (TypeScript, JavaScript, Python, Rust)
export const SUPPORTED_SYMBOL_ANALYSIS_EXTENSIONS = [
    ...TYPESCRIPT_EXTENSIONS,
    ...JAVASCRIPT_EXTENSIONS,
    ...PYTHON_EXTENSIONS,
    ...RUST_EXTENSIONS,
];

// Unified regex for source files we analyze across extension/webview/mcp
export const SUPPORTED_SOURCE_FILE_REGEX = /\.(ts|tsx|js|jsx|vue|svelte|gql|graphql|py|pyi|rs)$/;

export const IGNORED_DIRECTORIES = [
    'node_modules',
    '.git',
    'dist',
    'build',
    'out',
    'coverage',
    '.next',
    '.nuxt',
    '__pycache__',
    '.venv',
    'venv',
    'target',
];


export const WATCH_GLOB = "**/*.{ts,tsx,js,jsx,vue,svelte,gql,graphql,py,pyi,rs,toml}";

// Language-specific colors for UI visualization
// Used in webview for syntax highlighting, borders, and icons
export const LANGUAGE_COLORS: Record<string, string> = {
    // TypeScript
    typescript: '#3178c6',
    // JavaScript
    javascript: '#f7df1e',
    // Python
    python: '#3776ab',
    // Rust
    rust: '#ce422b',
    // Vue
    vue: '#41b883',
    // Svelte
    svelte: '#ff3e00',
    // GraphQL
    graphql: '#e535ab',
    // TOML (Rust config)
    toml: '#9c4221',
    // Unknown/default
    unknown: '#6b6b6b',
};

// File extension to color mapping for border colors in graph visualization
// Maps file extensions to their respective language colors
export const EXTENSION_COLORS: Record<string, string> = {
    '.ts': LANGUAGE_COLORS.typescript,
    '.tsx': LANGUAGE_COLORS.typescript,
    '.mts': LANGUAGE_COLORS.typescript,
    '.cts': LANGUAGE_COLORS.typescript,
    '.js': LANGUAGE_COLORS.javascript,
    '.jsx': LANGUAGE_COLORS.javascript,
    '.mjs': LANGUAGE_COLORS.javascript,
    '.cjs': LANGUAGE_COLORS.javascript,
    '.py': LANGUAGE_COLORS.python,
    '.pyi': LANGUAGE_COLORS.python,
    '.rs': LANGUAGE_COLORS.rust,
    '.vue': LANGUAGE_COLORS.vue,
    '.svelte': LANGUAGE_COLORS.svelte,
    '.gql': LANGUAGE_COLORS.graphql,
    '.graphql': LANGUAGE_COLORS.graphql,
    '.toml': LANGUAGE_COLORS.toml,
};
