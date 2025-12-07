export function logOperation(operation: string, data: string): void {
  console.log(`[${new Date().toISOString()}] ${operation}: ${data}`);
}
