import { performance } from 'node:perf_hooks';

export interface QueryLatencySnapshot {
  windowSeconds: 300;
  sampleCount: number;
  errorCount: number;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
}

interface QuerySample {
  at: number;
  latencyMs: number;
  failed: boolean;
}

const WINDOW_MS = 300_000;
const DEFAULT_MAX_SAMPLES = 5_000;

/** Process-local, bounded rolling window. It stores only timings, never query text. */
export class QueryLatencyWindow {
  private readonly samples: QuerySample[] = [];

  constructor(
    private readonly now: () => number = () => performance.now(),
    private readonly maxSamples = DEFAULT_MAX_SAMPLES,
  ) {}

  record(latencyMs: number, failed: boolean): void {
    const at = this.now();
    this.prune(at);
    if (!Number.isFinite(latencyMs) || latencyMs < 0) return;
    this.samples.push({ at, latencyMs, failed });
    if (this.samples.length > this.maxSamples) {
      this.samples.splice(0, this.samples.length - this.maxSamples);
    }
  }

  snapshot(): QueryLatencySnapshot {
    this.prune(this.now());
    const sorted = this.samples.map(({ latencyMs }) => latencyMs).sort((a, b) => a - b);
    const percentile = (fraction: number): number | null => {
      if (sorted.length === 0) return null;
      const index = Math.max(0, Math.ceil(fraction * sorted.length) - 1);
      return roundMilliseconds(sorted[index]);
    };
    return {
      windowSeconds: 300,
      sampleCount: this.samples.length,
      errorCount: this.samples.reduce((count, sample) => count + Number(sample.failed), 0),
      p50Ms: percentile(0.5),
      p95Ms: percentile(0.95),
      p99Ms: percentile(0.99),
    };
  }

  private prune(now: number): void {
    const oldest = now - WINDOW_MS;
    let firstRetained = 0;
    while (firstRetained < this.samples.length && this.samples[firstRetained].at < oldest) {
      firstRetained += 1;
    }
    if (firstRetained > 0) this.samples.splice(0, firstRetained);
  }
}

function roundMilliseconds(value: number): number {
  return Number(value.toFixed(2));
}
