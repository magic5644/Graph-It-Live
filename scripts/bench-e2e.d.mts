export interface MetricSummary {
  runs: number;
  p50Ms: number;
  p95Ms: number;
  peakRssMB: number | undefined;
}

export interface ThreadMemory {
  /** Heap after a forced GC at the end of each cycle */
  heapMB: number[];
  peakHeapMB: number;
}

export interface MemoryReport {
  cycles: number;
  peakRssMB: number | undefined;
  server: ThreadMemory;
  workers: ThreadMemory;
}

export interface HeapProbe {
  server: { heapMB: number; peakHeapMB: number };
  workers: { heapMB: number; peakHeapMB: number };
}

export interface CorpusReport {
  name: string;
  ref: string | undefined;
  files: number;
  cache: { reverseIndexBytes: number; callGraphBytes: number } | undefined;
  metrics: Record<string, MetricSummary>;
  memory?: MemoryReport;
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

export interface OssCorpus {
  url: string;
  tag: string;
  commit: string;
  /** SPDX expression, then the license file of the project */
  license: string;
  edit: string;
  file: string;
  symbol: string;
}

export const SELF_REF: string;
export const OSS_CORPORA: Record<string, OssCorpus>;
export function fetchCorpus(name: string, corpus: OssCorpus, corporaDir: string, root: string): void;
export function percentile(values: number[], p: number): number;
export function summarize(samples: Array<{ wallMs: number; rssMB?: number }>): MetricSummary;
export function generateCorpus(root: string, files: number): void;
export function readPeakRss(dir: string): number | undefined;
export function queueWaits(latencies: number[]): number[];
export function readHeapProbe(dir: string, cycle: number): HeapProbe;
export function summarizeMemory(probes: HeapProbe[], peakRssMB: number | undefined): MemoryReport;
export function renderReport(report: BenchReport): string;
export function parseOptions(args: string[]): { runs: number; files: number; cycles: number; corpora: string[]; vscode: boolean; corporaDir: string; out: string };
export function main(args: string[], env?: Record<string, string | undefined>): Promise<BenchReport>;
