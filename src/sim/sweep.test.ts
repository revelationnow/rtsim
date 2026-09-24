import { describe, expect, it } from 'vitest';
import { compile } from '../model/compile';
import type { Model } from '../model/types';
import { analyze } from './analysis';
import { runSweep, solve } from './sweep';

const model: Model = {
  name: 'solver check',
  params: { bw: '2 GB/s' },
  processors: [{ id: 'cpu', freq: '1 GHz' }],
  memories: [{ id: 'ddr', size: '1 GiB', bandwidth: 'bw', readLatency: '100 ns' }],
  buses: [{ id: 'bus', bandwidth: '100 GB/s', latency: '0 ns' }],
  links: [
    ['cpu', 'bus'],
    ['ddr', 'bus'],
  ],
  workplans: [
    {
      id: 'load',
      deadline: '1 ms',
      trigger: { type: 'periodic', period: '2 ms' },
      steps: [{ id: 'rd', kind: 'transfer', from: 'ddr', to: 'cpu', bytes: '1 MB' }],
    },
  ],
  sim: { duration: '10 ms' },
};

describe('solve', () => {
  it('finds the analytic minimum bandwidth for a deadline', () => {
    const r = solve(model, { param: 'bw', lo: 0.5, hi: 4, unit: 'GB/s', criterion: { type: 'deadlines' }, tolerance: 1e-4 });
    // 1e6 B must stream within 1 ms - 100 ns.
    const exact = 1e6 / (1e-3 - 100e-9) / 1e9;
    expect(r.status).toBe('found');
    expect(r.direction).toBe('min');
    expect(r.value!).toBeGreaterThanOrEqual(exact);
    expect(r.value! - exact).toBeLessThan(4 * 1e-4);
  });

  it('reports when the whole range passes', () => {
    const r = solve(model, { param: 'bw', lo: 2, hi: 4, unit: 'GB/s', criterion: { type: 'deadlines' } });
    expect(r.status).toBe('all-pass');
  });
});

describe('sweep', () => {
  it('runs once per value and flags misses below the requirement', () => {
    const pts = runSweep(model, { param: 'bw', values: ['0.8 GB/s', '2 GB/s'] });
    expect(pts.map((p) => p.metrics!.workplans[0].missed > 0)).toEqual([true, false]);
  });
});

describe('analysis', () => {
  it('predicts link demand as rate x bytes', () => {
    const c = compile(model);
    if (!c.ok) throw new Error('model should compile');
    const a = analyze(c.model);
    const ddr = a.demand.find((d) => d.id === 'ddr')!;
    expect(ddr.demand).toBeCloseTo(1e6 / 2e-3, 3);
    expect(ddr.utilization).toBeCloseTo(0.25, 9);
    expect(a.bounds[0].lowerBoundPs).toBe(100e3 + 500e6);
  });
});
