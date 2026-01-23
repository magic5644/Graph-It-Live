/**
 * Test fixture: Simple function call hierarchy for symbol analysis
 * Expected call graph: main() → helper() → logger()
 */

export function logger(message: string): void {
    console.log(message);
}

export function helper(data: string): string {
    logger(`Processing: ${data}`);
    return data.toUpperCase();
}

export function main(): void {
    const result = helper("test");
    logger(`Result: ${result}`);
}

// Expected SymbolNodes:
// - logger (function, lines 5-7)
// - helper (function, lines 9-12)
// - main (function, lines 14-17)

// Expected CallEdges:
// - main → helper (line 15, calls)
// - main → logger (line 16, calls)
// - helper → logger (line 10, calls)

// Expected Graph:
//     main
//    /    \
// helper  logger
//   |
// logger
