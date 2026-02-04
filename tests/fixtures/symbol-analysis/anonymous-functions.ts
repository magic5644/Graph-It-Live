/**
 * Test fixture: Anonymous functions with contextual names
 * Expected call graph: processData() → Array.map(callback) → Array.filter(predicate)
 */

export function processData(items: string[]): string[] {
    // Anonymous arrow function - should be named "map callback"
    const uppercase = items.map(item => item.toUpperCase()); // Line 8
    
    // Anonymous arrow function - should be named "filter predicate"
    const filtered = uppercase.filter(item => item.length > 3); // Line 11
    
    return filtered;
}

export function handleClick(): void {
    // Anonymous arrow function - should be named "onClick handler"
    const handler = () => {
        console.log('Clicked');
    }; // Line 19
    
    handler();
}

// Expected SymbolNodes:
// - processData (function, lines 6-14)
// - handleClick (function, lines 16-23)
// - "map callback" (anonymous function, line 8) [originalName: undefined]
// - "filter predicate" (anonymous function, line 11) [originalName: undefined]
// - "onClick handler" (anonymous function, lines 18-20) [originalName: undefined]

// Expected CallEdges:
// - processData → "map callback" (line 8, calls)
// - processData → "filter predicate" (line 11, calls)
// - handleClick → "onClick handler" (line 22, calls)
