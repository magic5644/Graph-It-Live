export interface MetricSummary {
  runs: number;
  p50Ms: number;
  p95Ms: number;
  peakRssMB: number | undefined;
}

export interface CorpusReport {
  name: string;
  ref: string | undefined;
  files: number;
  cache: { reverseIndexBytes: number; callGraphBytes: number } | undefined;
  metrics: Record<string, MetricSummary>;
}

export interface BenchReport {
  version: number;
  node: string;
  platform: string;
  arch: string;
  cpus: number;
  runs: number;
  corpora: CorpusReport[];
}

export const SELF_REF: string;
export function percentile(values: number[], p: number): number;
export function summarize(samples: Array<{ wallMs: number; rssMB?: number }>): MetricSummary;
export function generateCorpus(root: string, files: number): void;
export function readPeakRss(dir: string): number | undefined;
export function renderReport(report: BenchReport): string;
export function parseOptions(args: string[]): { runs: number; files: number; corpora: string[]; out: string };
export function main(args: string[], env?: Record<string, string | undefined>): Promise<BenchReport>;
