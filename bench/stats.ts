/** Timing / throughput statistics for bench samples. */

export interface Stats {
  readonly n: number;
  readonly min: number;
  readonly median: number;
  readonly p95: number;
  readonly mean: number;
  readonly max: number;
}

export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0]!;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  const w = idx - lo;
  return sorted[lo]! * (1 - w) + sorted[hi]! * w;
}

/** Compute min / median / p95 / mean / max over samples (any unit). */
export function summarize(samples: readonly number[]): Stats {
  if (samples.length === 0) {
    return { n: 0, min: NaN, median: NaN, p95: NaN, mean: NaN, max: NaN };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    n: sorted.length,
    min: sorted[0]!,
    median: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    mean: sum / sorted.length,
    max: sorted[sorted.length - 1]!,
  };
}

export function fmtMs(n: number): string {
  if (!Number.isFinite(n)) return 'n/a';
  if (n < 10) return `${n.toFixed(2)} ms`;
  if (n < 1000) return `${n.toFixed(1)} ms`;
  return `${(n / 1000).toFixed(2)} s`;
}

export function fmtMBps(n: number): string {
  if (!Number.isFinite(n)) return 'n/a';
  return `${n.toFixed(2)} MB/s`;
}

export function fmtStats(s: Stats, unit: 'ms' | 'MBps' = 'ms'): string {
  const f = unit === 'ms' ? fmtMs : fmtMBps;
  return `n=${s.n}  min=${f(s.min)}  median=${f(s.median)}  p95=${f(s.p95)}  mean=${f(s.mean)}  max=${f(s.max)}`;
}
