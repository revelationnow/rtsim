import type { Model } from '../model/types';
import { runModel } from './simulate';

/** Compact per-run metrics — sweeps run the simulator many times and keep only these. */
export interface RunMetrics {
  workplans: {
    id: string;
    released: number;
    missed: number;
    skipped: number;
    /** Fraction of activations that missed or were skipped. */
    failRate: number;
    mean: number;
    p99: number;
    max: number;
    e2eMax: number;
  }[];
  resources: { id: string; kind: string; utilization: number; peak: number }[];
  footprints: { id: string; peak: number; size: number }[];
}

export interface SweepPoint {
  value: string;
  ok: boolean;
  error?: string;
  metrics?: RunMetrics;
}

export function runMetrics(model: Model, overrides: Record<string, string>): { ok: true; metrics: RunMetrics } | { ok: false; error: string } {
  const r = runModel(model, { paramOverrides: overrides, statsOnly: true });
  if (!r.ok) {
    const first = r.issues?.find((i) => i.severity === 'error');
    return { ok: false, error: first ? `${first.path}: ${first.message}` : r.error };
  }
  return {
    ok: true,
    metrics: {
      workplans: r.workplans.map((w) => ({
        id: w.id,
        released: w.released,
        missed: w.missed,
        skipped: w.skipped,
        failRate: w.activations ? (w.missed + w.skipped) / w.activations : 0,
        mean: w.response.mean,
        p99: w.response.p99,
        max: w.response.max,
        e2eMax: w.e2e.max,
      })),
      resources: r.resources.map((x) => ({ id: x.id, kind: x.kind, utilization: x.utilization, peak: x.peakWindowUtil })),
      footprints: r.footprints.map((f) => ({ id: f.id, peak: f.peak, size: f.size })),
    },
  };
}

export interface SweepSpec {
  param: string;
  /** Each value is an expression, e.g. "12.8 GB/s". */
  values: string[];
}

export function runSweep(model: Model, spec: SweepSpec, onProgress?: (done: number, total: number) => void): SweepPoint[] {
  const out: SweepPoint[] = [];
  spec.values.forEach((value, i) => {
    const r = runMetrics(model, { [spec.param]: value });
    out.push(r.ok ? { value, ok: true, metrics: r.metrics } : { value, ok: false, error: r.error });
    onProgress?.(i + 1, spec.values.length);
  });
  return out;
}

/**
 * What must hold for a parameter value to count as meeting requirements.
 * - 'deadlines': no deadline misses or skipped activations (optionally for one workplan)
 * - 'p99' / 'max': that workplan's response-time statistic is at most `limitPs`
 * - 'util': that resource's average utilization is at most `limit` (0..1)
 */
export type Criterion =
  | { type: 'deadlines'; workplan?: string }
  | { type: 'p99' | 'max'; workplan: string; limitPs: number }
  | { type: 'util'; resource: string; limit: number };

export interface SolveSpec {
  param: string;
  lo: number;
  hi: number;
  /** Appended to each number to form the expression, e.g. "GB/s". */
  unit: string;
  criterion: Criterion;
  /** Stop when the bracket is narrower than this fraction of hi. */
  tolerance?: number;
  maxIter?: number;
}

export interface SolveResult {
  status: 'found' | 'all-pass' | 'none-pass' | 'error';
  /** The boundary value that just satisfies the criterion. */
  value?: number;
  /** Direction: 'min' when larger values pass (find the smallest), 'max' otherwise. */
  direction?: 'min' | 'max';
  message: string;
  trials: { value: number; pass: boolean; error?: string }[];
}

export function passes(m: RunMetrics, c: Criterion): boolean {
  switch (c.type) {
    case 'deadlines':
      return m.workplans.filter((w) => !c.workplan || w.id === c.workplan).every((w) => w.missed === 0 && w.skipped === 0);
    case 'p99':
    case 'max': {
      const w = m.workplans.find((x) => x.id === c.workplan);
      if (!w || w.released === 0) return false;
      return (c.type === 'p99' ? w.p99 : w.max) <= c.limitPs;
    }
    case 'util': {
      const r = m.resources.find((x) => x.id === c.resource);
      return !!r && r.utilization <= c.limit;
    }
  }
}

/**
 * Bisection on one parameter, assuming the criterion is monotone in it (more bandwidth or
 * clock never hurts). The endpoints decide the direction; the result is the tightest value
 * found that still passes.
 */
export function solve(model: Model, spec: SolveSpec, onProgress?: (done: number, total: number) => void): SolveResult {
  const tol = spec.tolerance ?? 0.002;
  const maxIter = spec.maxIter ?? 30;
  const trials: SolveResult['trials'] = [];
  const expected = Math.min(maxIter, Math.ceil(Math.log2(1 / tol)) + 2);
  const test = (v: number): boolean | string => {
    const r = runMetrics(model, { [spec.param]: `${v} ${spec.unit}`.trim() });
    const pass = r.ok ? passes(r.metrics, spec.criterion) : false;
    trials.push({ value: v, pass, error: r.ok ? undefined : r.error });
    onProgress?.(trials.length, expected);
    return r.ok ? pass : r.error;
  };
  let lo = spec.lo;
  let hi = spec.hi;
  if (!(hi > lo)) return { status: 'error', message: 'the upper bound must exceed the lower bound', trials };
  const pLo = test(lo);
  if (typeof pLo === 'string') return { status: 'error', message: pLo, trials };
  const pHi = test(hi);
  if (typeof pHi === 'string') return { status: 'error', message: pHi, trials };
  if (pLo && pHi) return { status: 'all-pass', value: lo, message: 'Both ends of the range pass; widen the range to find the boundary.', trials };
  if (!pLo && !pHi) return { status: 'none-pass', message: 'Neither end of the range passes.', trials };
  const direction = pHi ? 'min' : 'max';
  // Invariant: `good` passes, `bad` fails.
  let good = pHi ? hi : lo;
  let bad = pHi ? lo : hi;
  for (let i = 0; i < maxIter && Math.abs(good - bad) > tol * Math.max(Math.abs(hi), Math.abs(lo), 1e-300); i++) {
    const mid = (good + bad) / 2;
    const p = test(mid);
    if (typeof p === 'string') return { status: 'error', message: p, trials };
    if (p) good = mid;
    else bad = mid;
  }
  lo = Math.min(good, bad);
  hi = Math.max(good, bad);
  return {
    status: 'found',
    value: good,
    direction,
    message:
      direction === 'min'
        ? `Smallest passing value ≈ ${fmt(good)} ${spec.unit} (fails at ${fmt(bad)})`
        : `Largest passing value ≈ ${fmt(good)} ${spec.unit} (fails at ${fmt(bad)})`,
    trials,
  };
}

const fmt = (v: number) => +v.toPrecision(5);
