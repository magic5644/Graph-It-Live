// Extensions by language for type-safe language detection
export const TYPESCRIPT_EXTENSIONS = ['.ts', '.tsx'] as const;
export const JAVASCRIPT_EXTENSIONS = ['.js', '.jsx', '.mjs', '.cjs'] as const;
export const PYTHON_EXTENSIONS = ['.py', '.pyi'] as const;
export const RUST_EXTENSIONS = ['.rs'] as const;
export const VUE_EXTENSIONS = ['.vue'] as const;
export const SVELTE_EXTENSIONS = ['.svelte'] as const;
export const GRAPHQL_EXTENSIONS = ['.gql', '.graphql'] as const;
export const TOML_EXTENSIONS = ['.toml'] as const;
export const CSHARP_EXTENSIONS = ['.cs', '.csproj'] as const;
export const GO_EXTENSIONS = ['.go'] as const;
export const JAVA_EXTENSIONS = ['.java'] as const;

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
    ...CSHARP_EXTENSIONS,
    ...GO_EXTENSIONS,
    ...JAVA_EXTENSIONS,
];

// Derived: Extensions supported for AST symbol analysis (TypeScript, JavaScript, Vue/Svelte script blocks, Python, Rust)
export const SUPPORTED_SYMBOL_ANALYSIS_EXTENSIONS = [
    ...TYPESCRIPT_EXTENSIONS,
    ...JAVASCRIPT_EXTENSIONS,
    ...VUE_EXTENSIONS,
    ...SVELTE_EXTENSIONS,
    ...PYTHON_EXTENSIONS,
    ...RUST_EXTENSIONS,
];

// Unified regex for source files we analyze across extension/webview/mcp
export const SUPPORTED_SOURCE_FILE_REGEX = /\.(ts|tsx|js|jsx|mjs|cjs|vue|svelte|gql|graphql|py|pyi|rs|cs|csproj|go|java)$/;

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


export const WATCH_GLOB = "**/*.{ts,tsx,js,jsx,mjs,cjs,vue,svelte,gql,graphql,py,pyi,rs,toml,cs,csproj,go,java}";
/** graphit.architecture.json and its baseline (architectureRules.ts); the view reads them at the root only, so a nested match changes nothing. */
export const ARCHITECTURE_RULES_GLOB = "**/graphit.architecture{,.baseline}.json";
/**
 * Files PathResolver reads: tsconfig `paths` / `baseUrl` (and their `extends` targets), package.json `imports`,
 * `aliases`, `name` / `source` / `main` / `module` and `file:` dependencies (PathResolver.readResolverInputs()); not `exports`.
 * Matches every JSON file: an `extends` target may be named anything and the set changes with the tsconfig, so
 * Spider.isResolverConfig() filters the events (#431). RESOLVER_CONFIG_FILE_REGEX is the fixed-name subset.
 */
export const RESOLVER_CONFIG_GLOB = "**/*.json";
export const RESOLVER_CONFIG_FILE_REGEX = /(?:^|[\\/])(?:package|tsconfig[^\\/]*)\.json$/;

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
    // C#
    csharp: '#9b4f96',
    // Go
    go: '#00acd7',
    // Java
    java: '#f8981d',
    // Unknown/default
    unknown: '#6b6b6b',
};

const REACT_COLOR = '#087e99';
/** Framework identity stays separate from the JavaScript/TypeScript language. */
export const REACT_IDENTITY = {
    label: 'React',
    color: REACT_COLOR,
    foreground: '#ffffff',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="3" fill="${REACT_COLOR}"/><g fill="none" stroke="#ffffff" stroke-width="1.5"><ellipse cx="16" cy="16" rx="14" ry="5.5"/><ellipse cx="16" cy="16" rx="14" ry="5.5" transform="rotate(60 16 16)"/><ellipse cx="16" cy="16" rx="14" ry="5.5" transform="rotate(120 16 16)"/></g><circle cx="16" cy="16" r="2.5" fill="#ffffff"/></svg>`,
} as const;

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
    '.cs': LANGUAGE_COLORS.csharp,
    '.csproj': LANGUAGE_COLORS.csharp,
    '.go': LANGUAGE_COLORS.go,
    '.java': LANGUAGE_COLORS.java,
};
