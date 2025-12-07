// Shared utilities for benchmark tests
export const shared = "shared";
export function helper() { return "help"; }
export function formatDate(date: Date): string { return date.toISOString(); }
export function parseNumber(str: string): number { return Number.parseInt(str, 10); }
