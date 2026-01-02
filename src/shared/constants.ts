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