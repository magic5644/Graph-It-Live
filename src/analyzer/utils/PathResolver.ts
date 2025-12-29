import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { normalizePath } from '../types';
import { SUPPORTED_FILE_EXTENSIONS } from '../../shared/constants';

/**
 * Resolves module paths to absolute file paths
 * Handles:
 * - Relative imports (./utils, ../components/Button)
 * - TypeScript path aliases (@/, @components/)
 * - Node.js subpath imports (#internal/utils) via package.json "imports" field
 * - Implicit extensions (.ts, .tsx, .js, .jsx)
 * - Index files (/index.ts)
 * 
 * Monorepo-aware: discovers the nearest package.json for #imports resolution
 * 
 * CRITICAL: NO vscode imports allowed - pure Node.js only
 */
export class PathResolver {
  private readonly pathAliases: Map<string, string> = new Map();
  private tsConfigPromise?: Promise<void>;
  private readonly tsConfigPath?: string;
  private isConfigLoaded = false;

  private excludeNodeModules: boolean;

  // Workspace root - limit for config file discovery
  private readonly workspaceRoot?: string;

  // Cache: directory path -> nearest package.json path (or null if none found)
  private readonly directoryToPackageJson: Map<string, string | null> = new Map();

  // Cache: directory path -> nearest tsconfig.json path (or null if none found)
  private readonly directoryToTsConfig: Map<string, string | null> = new Map();

  // Cache: tsconfig.json path -> parsed path aliases map (alias -> target path)
  private readonly tsConfigPathAliases: Map<string, Map<string, string>> = new Map();

  // Cache: package.json path -> parsed imports map (alias -> target path)
  private readonly packageJsonImports: Map<string, Map<string, string>> = new Map();

  // Promises for loading package.json files (to avoid concurrent loads)
  private readonly packageJsonLoadPromises: Map<string, Promise<Map<string, string>>> = new Map();

  // Promises for loading tsconfig.json files (to avoid concurrent loads)
  private readonly tsConfigLoadPromises: Map<string, Promise<Map<string, string>>> = new Map();

  constructor(tsConfigPath?: string, excludeNodeModules: boolean = true, workspaceRoot?: string) {
    this.excludeNodeModules = excludeNodeModules;
    this.tsConfigPath = tsConfigPath;
    // Use provided workspaceRoot, or derive from tsConfigPath, or undefined
    this.workspaceRoot = workspaceRoot ?? (tsConfigPath ? path.dirname(tsConfigPath) : undefined);
  }

  /**
   * Update configuration
   */
  updateConfig(excludeNodeModules: boolean) {
    this.excludeNodeModules = excludeNodeModules;
  }

  /**
   * Ensure tsConfig is loaded before resolving
   */
  private async ensureTsConfigLoaded(): Promise<void> {
    if (this.isConfigLoaded || !this.tsConfigPath) {
      return;
    }

    this.tsConfigPromise ??= this.loadTsConfig(this.tsConfigPath);

    await this.tsConfigPromise;
    this.tsConfigPromise = undefined;
    this.isConfigLoaded = true;
  }

  /**
   * Load path aliases from tsconfig.json
   */
  private async loadTsConfig(tsConfigPath: string): Promise<void> {
    try {
      const content = await fs.readFile(tsConfigPath, 'utf-8');
      const tsConfig = JSON.parse(content);
      
      const paths = tsConfig?.compilerOptions?.paths;
      const baseUrl = tsConfig?.compilerOptions?.baseUrl || '.';
      
      if (paths) {
        for (const [alias, targets] of Object.entries(paths)) {
          // Remove trailing /* from alias
          const cleanAlias = alias.replace(/\/\*$/, '');
          
          // Get first target and remove trailing /*
          const target = (targets as string[])[0]?.replace(/\/\*$/, '');
          
          if (target) {
            // Resolve relative to tsconfig directory
            const tsConfigDir = path.dirname(tsConfigPath);
            const absoluteTarget = path.resolve(tsConfigDir, baseUrl, target);
            this.pathAliases.set(cleanAlias, normalizePath(absoluteTarget));
          }
        }
      }
    } catch {
      // Gracefully handle missing or invalid tsconfig
      // Silent failure - tsconfig is optional
    }
  }

  /**
   * Resolve a module path to an absolute file path
   */
  async resolve(currentFilePath: string, modulePath: string): Promise<string | null> {
    // Load static tsconfig if provided (legacy behavior for backwards compatibility)
    await this.ensureTsConfigLoaded();
    
    // Try static tsconfig alias (priority 1a)
    const staticAliasResolved = this.resolveAlias(modulePath);
    if (staticAliasResolved) {
      return this.resolveWithExtensions(staticAliasResolved);
    }

    // Try dynamic tsconfig alias (priority 1b)
    const dynamicAliasResolved = await this.resolveDynamicTsConfigAlias(currentFilePath, modulePath);
    if (dynamicAliasResolved) {
      return this.resolveWithExtensions(dynamicAliasResolved);
    }

    // Handle #imports (Node.js subpath imports)
    if (this.isSubpathImport(modulePath)) {
      return this.resolveSubpathImport(currentFilePath, modulePath);
    }

    // Handle @scope/package patterns
    if (this.isPackageJsonAliasCandidate(modulePath)) {
      return this.resolveScopedPackage(currentFilePath, modulePath);
    }

    // Handle node_modules
    if (this.isNodeModule(modulePath)) {
      return this.excludeNodeModules ? null : modulePath;
    }

    // Resolve relative paths
    if (this.isRelativePath(modulePath)) {
      const currentDir = path.dirname(currentFilePath);
      const absolutePath = path.resolve(currentDir, modulePath);
      return this.resolveWithExtensions(absolutePath);
    }

    return null;
  }

  /**
   * Resolve Node.js subpath import (#import)
   */
  private async resolveSubpathImport(currentFilePath: string, modulePath: string): Promise<string | null> {
    const resolved = await this.resolvePackageJsonImport(currentFilePath, modulePath);
    if (resolved) {
      return this.resolveWithExtensions(resolved);
    }
    return null;
  }

  /**
   * Resolve @scope/package pattern (package.json imports, workspace package, or node_module)
   */
  private async resolveScopedPackage(currentFilePath: string, modulePath: string): Promise<string | null> {
    // Try package.json imports field
    const pkgJsonResolved = await this.resolvePackageJsonImport(currentFilePath, modulePath);
    if (pkgJsonResolved) {
      return this.resolveWithExtensions(pkgJsonResolved);
    }

    // Try file: dependency resolution (from package.json dependencies)
    const fileDependencyResolved = await this.resolveWorkspacePackage(currentFilePath, modulePath);
    if (fileDependencyResolved) {
      return fileDependencyResolved;
    }

    // Treat as node_module
    return this.excludeNodeModules ? null : modulePath;
  }

  /**
   * Resolve an alias using the nearest tsconfig.json (dynamic discovery)
   */
  private async resolveDynamicTsConfigAlias(currentFilePath: string, modulePath: string): Promise<string | null> {
    // Only try for potential aliases (starts with @ or other non-relative patterns)
    if (!this.isPackageJsonAliasCandidate(modulePath)) {
      return null;
    }

    const tsConfigPath = await this.findNearestTsConfig(currentFilePath);
    if (!tsConfigPath) {
      return null;
    }

    const aliases = await this.getTsConfigPathAliases(tsConfigPath);
    
    for (const [alias, target] of aliases.entries()) {
      if (modulePath === alias || modulePath.startsWith(alias + '/')) {
            const resolved = modulePath.replace(alias, target);
            return normalizePath(resolved);
      }
    }

    return null;
  }

  /**
   * Find the nearest tsconfig.json by traversing up from the file's directory
   * Stops at workspaceRoot
   */
  private async findNearestTsConfig(filePath: string): Promise<string | null> {
    const startDir = path.dirname(filePath);

    // Check cache first for this directory
    if (this.directoryToTsConfig.has(startDir)) {
      return this.directoryToTsConfig.get(startDir) ?? null;
    }

    const result = await this.searchTsConfigUpward(startDir);
    return result;
  }

  /**
   * Search for tsconfig.json by traversing up directories
   * Caches results for all checked directories
   */
  private async searchTsConfigUpward(startDir: string): Promise<string | null> {
    const checkedDirs: string[] = [];
    let currentDir = startDir;

    while (!this.shouldStopSearch(currentDir)) {
      checkedDirs.push(currentDir);

      // Check if we already know the result for this directory
      const cachedResult = this.directoryToTsConfig.get(currentDir);
      if (cachedResult !== undefined) {
        this.cacheTsConfigResultForDirs(checkedDirs, cachedResult);
        return cachedResult;
      }

      const tsConfigPath = path.join(currentDir, 'tsconfig.json');
      const exists = await this.fileExists(tsConfigPath);
      if (exists) {
        this.cacheTsConfigResultForDirs(checkedDirs, tsConfigPath);
        return tsConfigPath;
      }

      const parentDir = path.dirname(currentDir);
      if (parentDir === currentDir) {
        break; // Reached filesystem root
      }
      currentDir = parentDir;
    }

    // No tsconfig.json found
    this.cacheTsConfigResultForDirs(checkedDirs, null);
    return null;
  }

  /**
   * Cache the tsconfig.json result for all checked directories
   */
  private cacheTsConfigResultForDirs(dirs: string[], result: string | null): void {
    for (const dir of dirs) {
      this.directoryToTsConfig.set(dir, result);
    }
  }

  /**
   * Get parsed path aliases from a tsconfig.json file (cached)
   */
  private async getTsConfigPathAliases(tsConfigPath: string): Promise<Map<string, string>> {
    // Return from cache if already loaded
    if (this.tsConfigPathAliases.has(tsConfigPath)) {
      return this.tsConfigPathAliases.get(tsConfigPath)!;
    }

    // Check if already loading
    if (this.tsConfigLoadPromises.has(tsConfigPath)) {
      return this.tsConfigLoadPromises.get(tsConfigPath)!;
    }

    // Start loading and cache the promise
    const loadPromise = this.loadTsConfigPathAliases(tsConfigPath);
    this.tsConfigLoadPromises.set(tsConfigPath, loadPromise);

    try {
      const aliases = await loadPromise;
      this.tsConfigPathAliases.set(tsConfigPath, aliases);
      return aliases;
    } finally {
      this.tsConfigLoadPromises.delete(tsConfigPath);
    }
  }

  /**
   * Load and parse path aliases from a tsconfig.json file
   * Follows the "extends" chain to inherit aliases from parent configs
   */
  private async loadTsConfigPathAliases(tsConfigPath: string): Promise<Map<string, string>> {
    const aliases = new Map<string, string>();
    const visited = new Set<string>();

    await this.loadTsConfigPathAliasesRecursive(tsConfigPath, aliases, visited);

    return aliases;
  }

  /**
   * Recursively load path aliases, following "extends" chain
   */
  private async loadTsConfigPathAliasesRecursive(
    tsConfigPath: string,
    aliases: Map<string, string>,
    visited: Set<string>
  ): Promise<void> {
    // Prevent infinite loops
    const normalizedPath = path.resolve(tsConfigPath);
    if (visited.has(normalizedPath)) {
      return;
    }
    visited.add(normalizedPath);

    try {
      const content = await fs.readFile(tsConfigPath, 'utf-8');
      const tsConfig = JSON.parse(content);
      const tsConfigDir = path.dirname(tsConfigPath);

      // First, process "extends" to get parent aliases (they have lower priority)
      if (tsConfig.extends) {
        const extendsPath = path.resolve(tsConfigDir, tsConfig.extends);
        // Try with .json extension if not present
        const parentPath = extendsPath.endsWith('.json') ? extendsPath : extendsPath + '.json';
        const actualParentPath = await this.fileExists(parentPath) ? parentPath : extendsPath;
        
        if (await this.fileExists(actualParentPath)) {
          await this.loadTsConfigPathAliasesRecursive(actualParentPath, aliases, visited);
        }
      }

      // Then, process this config's paths (they override parent aliases)
      const paths = tsConfig?.compilerOptions?.paths;
      const baseUrl = tsConfig?.compilerOptions?.baseUrl || '.';

      if (paths) {
        for (const [alias, targets] of Object.entries(paths)) {
          // Remove trailing /* from alias
          const cleanAlias = alias.replace(/\/\*$/, '');

          // Get first target and remove trailing /*
          const target = (targets as string[])[0]?.replace(/\/\*$/, '');

          if (target) {
            // Resolve relative to this tsconfig's directory
            const absoluteTarget = path.resolve(tsConfigDir, baseUrl, target);
            aliases.set(cleanAlias, normalizePath(absoluteTarget));
          }
        }
      }
    } catch {
      // Gracefully handle missing or invalid tsconfig
      // Silent failure - tsconfig is optional
    }
  }

  /**
   * Resolve path aliases
   */
  private resolveAlias(modulePath: string): string | null {
    for (const [alias, target] of this.pathAliases.entries()) {
      if (modulePath === alias || modulePath.startsWith(alias + '/')) {
        // Replace alias with target path
        const resolved = modulePath.replace(alias, target);
        return resolved;
      }
    }
    return null;
  }

  /**
   * Try different file extensions
   */
  private async resolveWithExtensions(basePath: string): Promise<string | null> {
    const extensions = SUPPORTED_FILE_EXTENSIONS;
    
    // Try exact path first
    if (await this.fileExists(basePath)) {
      return normalizePath(basePath);
    }

    // Try with extensions
    for (const ext of extensions) {
      const pathWithExt = basePath + ext;
      if (await this.fileExists(pathWithExt)) {
        return normalizePath(pathWithExt);
      }
    }

    // Try index files
    for (const ext of extensions) {
      const indexPath = path.join(basePath, `index${ext}`);
      if (await this.fileExists(indexPath)) {
        return normalizePath(indexPath);
      }
    }

    return null;
  }

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      const stats = await fs.stat(filePath);
      return stats.isFile();
    } catch {
      return false;
    }
  }

  private isRelativePath(modulePath: string): boolean {
    return modulePath.startsWith('./') || modulePath.startsWith('../');
  }

  private isNodeModule(modulePath: string): boolean {
    // Node modules don't start with . or / or # or @
    // Note: @scoped/packages are handled separately via isPackageJsonAliasCandidate
    return !modulePath.startsWith('.') && !modulePath.startsWith('/') && !modulePath.startsWith('#') && !modulePath.startsWith('@');
  }

  /**
   * Check if module path is a Node.js subpath import (#import)
   */
  private isSubpathImport(modulePath: string): boolean {
    return modulePath.startsWith('#');
  }

  /**
   * Check if module path could be an alias defined in package.json imports
   * This covers @alias patterns like @shared/*, @components/*, etc.
   */
  private isPackageJsonAliasCandidate(modulePath: string): boolean {
    // Match @something/* patterns that could be defined in package.json imports
    return modulePath.startsWith('@');
  }

  /**
   * Resolve an import via the nearest package.json imports field
   * Supports both #imports and @alias imports
   */
  private async resolvePackageJsonImport(currentFilePath: string, modulePath: string): Promise<string | null> {
    const packageJsonPath = await this.findNearestPackageJson(currentFilePath);
    if (!packageJsonPath) {
      return null;
    }

    const imports = await this.getPackageJsonImports(packageJsonPath);
    const packageDir = path.dirname(packageJsonPath);

    // Try exact match first
    if (imports.has(modulePath)) {
      const target = imports.get(modulePath)!;
      return normalizePath(path.resolve(packageDir, target));
    }

    // Try wildcard match (e.g., #internal/* -> ./src/internal/*)
    for (const [alias, target] of imports.entries()) {
      if (alias.endsWith('/*')) {
        const aliasPrefix = alias.slice(0, -2); // Remove /*
        if (modulePath.startsWith(aliasPrefix + '/')) {
          const suffix = modulePath.slice(aliasPrefix.length + 1); // Get part after prefix/
          const targetPrefix = target.endsWith('/*') ? target.slice(0, -2) : target;
          const resolved = path.resolve(packageDir, targetPrefix, suffix);
          return normalizePath(resolved);
        }
      }
    }

    return null;
  }

  /**
   * Find the nearest package.json by traversing up from the file's directory
   * Stops at workspaceRoot
   */
  private async findNearestPackageJson(filePath: string): Promise<string | null> {
    const startDir = path.dirname(filePath);

    // Check cache first for this directory
    if (this.directoryToPackageJson.has(startDir)) {
      return this.directoryToPackageJson.get(startDir) ?? null;
    }

    const result = await this.searchPackageJsonUpward(startDir);
    return result;
  }

  /**
   * Search for package.json by traversing up directories
   * Caches results for all checked directories
   */
  private async searchPackageJsonUpward(startDir: string): Promise<string | null> {
    const checkedDirs: string[] = [];
    let currentDir = startDir;

    while (!this.shouldStopSearch(currentDir)) {
      checkedDirs.push(currentDir);

      // Check if we already know the result for this directory
      const cachedResult = this.directoryToPackageJson.get(currentDir);
      if (cachedResult !== undefined) {
        this.cacheResultForDirs(checkedDirs, cachedResult);
        return cachedResult;
      }

      const packageJsonPath = path.join(currentDir, 'package.json');
      if (await this.fileExists(packageJsonPath)) {
        this.cacheResultForDirs(checkedDirs, packageJsonPath);
        return packageJsonPath;
      }

      const parentDir = path.dirname(currentDir);
      if (parentDir === currentDir) {
        break; // Reached filesystem root
      }
      currentDir = parentDir;
    }

    // No package.json found
    this.cacheResultForDirs(checkedDirs, null);
    return null;
  }

  /**
   * Check if we should stop searching for package.json
   */
  private shouldStopSearch(currentDir: string): boolean {
    return Boolean(this.workspaceRoot && currentDir === path.dirname(this.workspaceRoot));
  }

  /**
   * Cache the package.json result for all checked directories
   */
  private cacheResultForDirs(dirs: string[], result: string | null): void {
    for (const dir of dirs) {
      this.directoryToPackageJson.set(dir, result);
    }
  }

  /**
   * Get parsed imports from a package.json file (cached)
   */
  private async getPackageJsonImports(packageJsonPath: string): Promise<Map<string, string>> {
    // Return from cache if already loaded
    if (this.packageJsonImports.has(packageJsonPath)) {
      return this.packageJsonImports.get(packageJsonPath)!;
    }

    // Check if already loading
    if (this.packageJsonLoadPromises.has(packageJsonPath)) {
      return this.packageJsonLoadPromises.get(packageJsonPath)!;
    }

    // Start loading and cache the promise
    const loadPromise = this.loadPackageJsonImports(packageJsonPath);
    this.packageJsonLoadPromises.set(packageJsonPath, loadPromise);

    try {
      const imports = await loadPromise;
      this.packageJsonImports.set(packageJsonPath, imports);
      return imports;
    } finally {
      this.packageJsonLoadPromises.delete(packageJsonPath);
    }
  }

  /**
   * Load and parse the imports field from a package.json file
   * Also loads aliases field if present (custom extension for @alias support)
   */
  private async loadPackageJsonImports(packageJsonPath: string): Promise<Map<string, string>> {
    const imports = new Map<string, string>();

    try {
      const content = await fs.readFile(packageJsonPath, 'utf-8');
      const packageJson = JSON.parse(content);

      // Load standard Node.js subpath imports (#imports)
      this.parseImportsField(packageJson?.imports, imports);

      // Also check "aliases" field (some projects use this for @scope/package mappings)
      this.parseAliasesField(packageJson?.aliases, imports);
    } catch {
      // Gracefully handle missing or invalid package.json
    }

    return imports;
  }

  /**
   * Parse the imports field from package.json
   */
  private parseImportsField(importsField: unknown, imports: Map<string, string>): void {
    if (!importsField || typeof importsField !== 'object') {
      return;
    }

    for (const [alias, target] of Object.entries(importsField)) {
      const resolved = this.resolveImportTarget(target);
      if (resolved) {
        imports.set(alias, resolved);
      }
    }
  }

  /**
   * Resolve an import target (handles simple strings and conditional exports)
   */
  private resolveImportTarget(target: unknown): string | null {
    if (typeof target === 'string') {
      return target;
    }
    
    if (typeof target === 'object' && target !== null) {
      const obj = target as Record<string, unknown>;
      const resolved = obj.default ?? obj.import ?? obj.require ?? obj.node;
      if (typeof resolved === 'string') {
        return resolved;
      }
    }
    
    return null;
  }

  /**
   * Parse the aliases field from package.json (custom extension)
   */
  private parseAliasesField(aliasesField: unknown, imports: Map<string, string>): void {
    if (!aliasesField || typeof aliasesField !== 'object') {
      return;
    }

    for (const [alias, target] of Object.entries(aliasesField)) {
      if (typeof target === 'string') {
        imports.set(alias, target);
      }
    }
  }

  /**
   * Try to resolve @scope/package as a local workspace package
   * This handles monorepos where @company/auth-lib points to packages/auth-lib
   * Supports:
   * 1. "file:" dependencies in package.json (e.g., "@company/auth-lib": "file:../packages/auth-lib")
   * 2. Common monorepo package locations (packages/, libs/, modules/)
   */
  private async resolveWorkspacePackage(currentFilePath: string, modulePath: string): Promise<string | null> {
    if (!modulePath.startsWith('@')) {
      return null;
    }

    // Extract scope and package name: @company/auth-lib -> company, auth-lib
    const regex = /^@([^/]+)\/([^/]+)(\/.*)?$/;
    const match = regex.exec(modulePath);
    if (!match) {
      return null;
    }

    const [, , packageName, subpath] = match;
    const fullPackageName = modulePath.split('/').slice(0, 2).join('/'); // @company/auth-lib
    
    // Try file: dependency resolution first (from nearest package.json dependencies)
    const fileDependencyDir = await this.resolveFileDependency(currentFilePath, fullPackageName);
    if (fileDependencyDir) {
      return this.resolvePackageEntry(fileDependencyDir, modulePath, subpath);
    }
    
    // Fallback: try common monorepo package locations
    if (this.workspaceRoot) {
      const packageDir = await this.findWorkspacePackageDir(packageName);
      if (packageDir) {
        return this.resolvePackageEntry(packageDir, modulePath, subpath);
      }
    }

    return null;
  }
  
  /**
   * Resolve a package that's defined as "file:" dependency in package.json
   * Searches upward through all package.json files to find the dependency
   * In monorepos, file: dependencies may be declared in a parent package.json
   * e.g., "@company/auth-lib": "file:../packages/auth-lib"
   */
  private async resolveFileDependency(currentFilePath: string, packageName: string): Promise<string | null> {
    const startDir = path.dirname(currentFilePath);
    let currentDir = startDir;

    // Search upward through all package.json files
    while (!this.shouldStopSearch(currentDir)) {
      const packageJsonPath = path.join(currentDir, 'package.json');
      
      if (await this.fileExists(packageJsonPath)) {
        const result = await this.findFileDependencyInPackageJson(packageJsonPath, packageName);
        if (result) {
          return result;
        }
      }

      const parentDir = path.dirname(currentDir);
      if (parentDir === currentDir) {
        break; // Reached filesystem root
      }
      currentDir = parentDir;
    }

    return null;
  }

  /**
   * Look for a file: dependency in a package.json file
   */
  private async findFileDependencyInPackageJson(packageJsonPath: string, packageName: string): Promise<string | null> {
    try {
      const content = await fs.readFile(packageJsonPath, 'utf-8');
      const pkgJson = JSON.parse(content);
      const packageDir = path.dirname(packageJsonPath);
      
      // Check dependencies, devDependencies, and peerDependencies for file: references
      const allDeps = {
        ...pkgJson.dependencies,
        ...pkgJson.devDependencies,
        ...pkgJson.peerDependencies,
      };
      
      const depValue = allDeps[packageName];
      
      if (typeof depValue === 'string' && depValue.startsWith('file:')) {
        // Remove "file:" prefix and resolve relative to package.json directory
        const relativePath = depValue.slice(5);
        const absolutePath = path.resolve(packageDir, relativePath);
        const normalized = normalizePath(absolutePath);
        
        // Verify the directory exists and has a package.json
        const depPackageJson = path.join(absolutePath, 'package.json');
        const exists = await this.fileExists(depPackageJson);
        
        if (exists) {
          return normalized;
        }
      }
    } catch {
      // Ignore errors reading package.json
    }

    return null;
  }

  /**
   * Find the package directory in the workspace
   */
  private async findWorkspacePackageDir(packageName: string): Promise<string | null> {
    if (!this.workspaceRoot) {
      return null;
    }

    // Common monorepo package locations
    const locations = ['packages', 'libs', 'modules'];
    
    for (const loc of locations) {
      const packageDir = path.join(this.workspaceRoot, loc, packageName);
      const packageJsonPath = path.join(packageDir, 'package.json');
      
      if (await this.fileExists(packageJsonPath)) {
        return packageDir;
      }
    }

    return null;
  }

  /**
   * Resolve the entry point of a workspace package
   */
  private async resolvePackageEntry(packageDir: string, modulePath: string, subpath?: string): Promise<string | null> {
    const packageJsonPath = path.join(packageDir, 'package.json');

    try {
      const content = await fs.readFile(packageJsonPath, 'utf-8');
      const pkgJson = JSON.parse(content);
      
      // Verify this is the right package
      // Package can be named @scope/package or just package (for file: dependencies)
      const expectedName = modulePath.split('/').slice(0, 2).join('/'); // @company/auth-lib
      const shortName = modulePath.split('/').slice(1, 2).join('/'); // auth-lib
      const pkgName = pkgJson.name as string;
      
      // Accept if package name matches either the full scoped name or just the short name
      if (pkgName !== expectedName && pkgName !== shortName) {
        return null;
      }

      // Handle subpath imports
      if (subpath) {
        const srcDir = pkgJson.source ? path.dirname(pkgJson.source) : 'src';
        const subpathResolved = path.join(packageDir, srcDir, subpath);
        return this.resolveWithExtensions(subpathResolved);
      }

      // Try common entry points
      return this.findPackageEntryPoint(packageDir, pkgJson);
    } catch {
      return null;
    }
  }

  /**
   * Find the entry point of a package
   */
  private async findPackageEntryPoint(packageDir: string, pkgJson: Record<string, unknown>): Promise<string | null> {
    const main = (pkgJson.main as string) || (pkgJson.module as string) || 'index';
    
    const entryPoints = [
      path.join(packageDir, 'src', 'index'),
      path.join(packageDir, main),
      path.join(packageDir, 'index'),
    ];
    
    for (const entry of entryPoints) {
      const resolved = await this.resolveWithExtensions(entry);
      if (resolved) {
        return resolved;
      }
    }

    return null;
  }
}
