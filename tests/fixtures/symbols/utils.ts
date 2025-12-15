export type UsedType = { value: string };

export type UnusedType = { count: number };

export function usedFunc(input: UsedType) {
  return input.value;
}

export function unusedFunc() {
  return 'unused';
}
