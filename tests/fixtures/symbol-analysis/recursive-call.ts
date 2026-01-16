/**
 * Test fixture: Recursive function call for cycle detection
 * Expected call graph: factorial() → factorial() (cycle)
 */

export function factorial(n: number): number {
    if (n <= 1) {
        return 1;
    }
    return n * factorial(n - 1); // Recursive call on line 10
}

export function testFactorial(): void {
    const result = factorial(5);
    console.log(result);
}

// Expected SymbolNodes:
// - factorial (function, lines 6-11)
// - testFactorial (function, lines 13-16)

// Expected CallEdges:
// - factorial → factorial (line 10, calls) - CYCLE
// - testFactorial → factorial (line 14, calls)

// Expected Graph:
// testFactorial → factorial ⟲ (cycle indicator)
