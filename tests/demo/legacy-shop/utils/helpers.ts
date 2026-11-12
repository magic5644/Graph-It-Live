export function slugify(text: string): string {
  return text.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-");
}

export function deepClone<T>(value: T): T {
  return structuredClone(value);
}

export function retry<T>(fn: () => T, attempts = 3): T {
  for (let i = 1; ; i++) {
    try {
      return fn();
    } catch (error) {
      if (i >= attempts) throw error;
    }
  }
}
