export const NPM_PACKAGE_NAME: string;
export const NPM_RUNTIME_DEPENDENCIES: string[];
export const NPM_FILES: string[];

export function npmManifest<T extends { dependencies?: Record<string, string> }>(
  pkg: T,
): T & { name: string; files: string[]; dependencies: Record<string, string> };
