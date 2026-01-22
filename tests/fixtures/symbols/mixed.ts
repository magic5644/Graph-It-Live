/**
 * Test fixture for T055, T058: Mixed symbol types with imports/exports
 * Tests color coding and breadcrumb navigation
 */

// Import from local module
import { UserService } from './classes';
import { helperA, helperB } from './functions';

// Variable - amber color (#FFA500)
export const APP_VERSION = '1.0.0';

// Function - blue color (#4A9EFF)
export function initializeApp(): void {
  const service = new UserService(); // Instantiate class
  const version = APP_VERSION; // Use variable
  console.log(`App ${version} initialized`);
}

// Class - purple color (#9966CC)
export class ConfigManager {
  // Property - amber
  private config: Record<string, string> = {};
  
  // Method - blue
  get(key: string): string | undefined {
    return this.config[key];
  }
  
  // Method - blue
  set(key: string, value: string): void {
    this.config[key] = value;
  }
}

// Function with mixed calls - blue
export function setupApplication(): ConfigManager {
  initializeApp(); // Call to function
  const manager = new ConfigManager(); // Instantiate class
  manager.set('version', APP_VERSION); // Call method, use variable
  return manager;
}

// Function that uses imported functions
export function processHelpers(): string {
  const a = helperA(); // External call (from functions.ts)
  const b = helperB(); // External call (from functions.ts)
  return a + b;
}

// Async function - blue
export async function fetchAndProcess(userId: number): Promise<void> {
  const service = new UserService();
  const user = await service.getUser(userId); // Method call on instance
  console.log(user);
}

// Type definitions
interface AppConfig {
  version: string;
  environment: 'dev' | 'prod';
}

// Exported type
export type { AppConfig };
