export const SUPPORTED_FILE_EXTENSIONS = [
    '.ts',
    '.tsx',
    '.js',
    '.jsx',
    '.vue',
    '.svelte',
    '.mjs',
    '.cjs',
    '.gql',
    '.graphql',
    '.py',
    '.pyi',
    '.rs',
    '.toml',
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