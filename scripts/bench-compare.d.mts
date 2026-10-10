export interface BenchRow {
  name: string;
  base: number | undefined;
  head: number | undefined;
  status: 'regression' | 'gain' | 'noise' | 'added' | 'removed';
}

export const MARKER: string;
export function median(values: number[]): number;
export function collectSamples(reports: unknown[]): Map<string, number[]>;
export function classify(base: number[] | undefined, head: number[] | undefined, threshold: number): BenchRow['status'];
export function compareBenchmarks(baseReports: unknown[], headReports: unknown[], threshold: number): BenchRow[];
export function renderBenchComment(rows: BenchRow[], options: { threshold: number; runs: number }): string;
export function postComment(fetchImpl: typeof fetch, env: Record<string, string | undefined>, body: string): Promise<unknown>;
export function main(
  args: string[],
  env?: Record<string, string | undefined>,
  fetchImpl?: typeof fetch,
): Promise<string>;
