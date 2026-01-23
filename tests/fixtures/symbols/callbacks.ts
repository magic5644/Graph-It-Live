/**
 * Test fixture for T058a: Anonymous functions with contextual naming
 * Contains arrow functions, callbacks, and event handlers
 */

// Array methods with arrow function callbacks
export function processData(items: number[]): number[] {
  // T089: Anonymous function contextual naming
  // Should infer "map callback" from context
  const doubled = items.map((x) => x * 2);
  
  // Should infer "filter predicate"
  const positive = doubled.filter((x) => x > 0);
  
  // Should infer "reduce callback"
  const _sum = positive.reduce((acc, val) => acc + val, 0);
  
  return positive;
}

// Event handler patterns
export class ButtonComponent {
  // Should infer "onClick handler"
  onClick = () => {
    console.log('Button clicked');
  };
  
  // Should infer "onSubmit handler"
  onSubmit = () => {
    console.log('Form submitted');
  };
  
  // Should infer "setTimeout callback"
  delayedAction() {
    setTimeout(() => {
      console.log('Delayed action');
    }, 1000);
  }
}

// Promise chains with arrow functions
export async function fetchData(url: string): Promise<void> {
  // Should infer "then callback"
  fetch(url)
    .then((response) => response.json())
    .then((data) => console.log(data))
    .catch((error) => console.error(error)); // Should infer "catch handler"
}

// Higher-order functions
export function createMultiplier(factor: number): (x: number) => number {
  // Should infer "factory return function" or similar
  return (x) => x * factor;
}
