import { describe, expect, it } from 'vitest';
import type { Model, StepSpec, WorkplanSpec } from '../model/types';
import type { SimResult } from './result';
import { peakWindowAverage } from './series';
import { runModel } from './simulate';

const NS = 1e3;
const US = 1e6;
const MS = 1e9;

/** DDR -- noc -- cpu (+ sram, dma on the noc). Bandwidths chosen for round numbers. */
function base(workplans: WorkplanSpec[], patch: Partial<Model> = {}): Model {
  return {
    name: 'test',
    processors: [{ id: 'cpu', freq: '1 GHz', cores: 1, policy: 'fifo' }],
    memories: [
      { id: 'ddr', size: '1 GiB', bandwidth: '10 GB/s', readLatency: '100 ns', writeLatency: '100 ns' },
      { id: 'sram', size: '1 MiB', bandwidth: '100 GB/s', readLatency: '0 ns' },
    ],
    buses: [{ id: 'noc', bandwidth: '16 GB/s', latency: '10 ns' }],
    dmas: [{ id: 'dma', channels: 4 }],
    links: [
      ['ddr', 'noc'],
      ['sram', 'noc'],
      ['cpu', 'noc'],
      ['dma', 'noc'],
    ],
    workplans,
    sim: { duration: '10 ms', seed: 7 },
    ...patch,
  };
}

function once(id: string, steps: StepSpec[], extra: Partial<WorkplanSpec> = {}): WorkplanSpec {
  return { id, trigger: { type: 'times', times: ['0 s'] }, steps, ...extra };
}

function run(m: Model): SimResult {
  const r = runModel(m);
  if (!r.ok) throw new Error(`${r.error}\n${JSON.stringify(r.issues ?? [], null, 2)}`);
  return r;
}

const wp = (r: SimResult, id: string) => r.workplans.find((w) => w.id === id)!;
const res = (r: SimResult, id: string) => r.resources.find((x) => x.id === id)!;

describe('transfers', () => {
  it('costs latency plus bytes over the bottleneck bandwidth', () => {
    const r = run(base([once('a', [{ id: 'rd', kind: 'transfer', from: 'ddr', to: 'cpu', bytes: '1 MB' }])]));
    // 100 ns DDR + 10 ns hop, then 1e6 B at min(10, 16) GB/s = 100 us.
    expect(wp(r, 'a').response.max).toBe(110 * NS + 100 * US);
    expect(res(r, 'ddr').bytes).toBeCloseTo(1e6, 3);
  });

  it('splits a shared link fairly between two streams', () => {
    const r = run(
      base([
        once('a', [{ id: 'x', kind: 'transfer', from: 'ddr', to: 'cpu', bytes: '1 MB' }]),
        once('b', [{ id: 'x', kind: 'transfer', from: 'ddr', to: 'cpu', bytes: '1 MB' }]),
      ]),
    );
    // Both stream at 5 GB/s through the DDR bottleneck.
    expect(wp(r, 'a').response.max).toBe(110 * NS + 200 * US);
    expect(wp(r, 'b').response.max).toBe(110 * NS + 200 * US);
  });

  it('serves the higher-priority stream first under priority arbitration', () => {
    const r = run(
      base([
        once('hi', [{ id: 'x', kind: 'transfer', from: 'ddr', to: 'cpu', bytes: '1 MB' }], { priority: 5 }),
        once('lo', [{ id: 'x', kind: 'transfer', from: 'ddr', to: 'cpu', bytes: '1 MB' }], { priority: 1 }),
      ]),
    );
    expect(wp(r, 'hi').response.max).toBe(110 * NS + 100 * US);
    expect(wp(r, 'lo').response.max).toBe(110 * NS + 200 * US);
  });

  it('ignores priorities with fair arbitration', () => {
    const r = run(
      base(
        [
          once('hi', [{ id: 'x', kind: 'transfer', from: 'ddr', to: 'cpu', bytes: '1 MB' }], { priority: 5 }),
          once('lo', [{ id: 'x', kind: 'transfer', from: 'ddr', to: 'cpu', bytes: '1 MB' }], { priority: 1 }),
        ],
        { sim: { duration: '10 ms', arbitration: 'fair' } },
      ),
    );
    expect(wp(r, 'hi').response.max).toBe(wp(r, 'lo').response.max);
  });

  it('re-shares bandwidth when a stream finishes (max-min progressive filling)', () => {
    const r = run(
      base([
        once('small', [{ id: 'x', kind: 'transfer', from: 'ddr', to: 'cpu', bytes: '0.5 MB' }]),
        once('big', [{ id: 'x', kind: 'transfer', from: 'ddr', to: 'cpu', bytes: '1 MB' }]),
      ]),
    );
    // Shared at 5 GB/s until small finishes at 100 us; big then has 0.5 MB left at 10 GB/s.
    expect(wp(r, 'small').response.max).toBe(110 * NS + 100 * US);
    expect(wp(r, 'big').response.max).toBe(110 * NS + 150 * US);
  });

  it('gives an unconstrained stream the capacity a capped one leaves over', () => {
    const m = base([
      once('capped', [{ id: 'x', kind: 'transfer', from: 'ddr', to: 'sram', via: 'slow', bytes: '0.2 MB' }]),
      once('free', [{ id: 'x', kind: 'transfer', from: 'ddr', to: 'cpu', bytes: '1 MB' }]),
    ]);
    // 2 outstanding x 64 B over a 2x10 ns + 100 ns round trip = 1.0667 GB/s cap on reads.
    m.dmas!.push({ id: 'slow', channels: 1, maxOutstanding: 2, burst: 64 });
    m.links.push(['slow', 'noc']);
    m.memories[0].bandwidth = '100 GB/s';
    m.buses[0].bandwidth = '4 GB/s';
    const r = run(m);
    // The NoC carries the DMA's read and write legs (coefficient 2): 2 x 1.0667 GB/s,
    // leaving 4 - 2.1333 = 1.8667 GB/s for the free stream while the capped one runs.
    const cap = (2 * 64) / 120e-9;
    const cappedStream = 0.2e6 / cap;
    // Latency: 100 ns DDR + 10 ns read hop + 10 ns write hop + 0 ns SRAM.
    expect(wp(r, 'capped').response.max / MS).toBeCloseTo((120 * NS + cappedStream * 1e12) / MS, 6);
    const freeLeft = 1e6 - (4e9 - 2 * cap) * cappedStream;
    const freeT = cappedStream + freeLeft / 4e9;
    expect(wp(r, 'free').response.max / MS).toBeCloseTo((110 * NS + freeT * 1e12) / MS, 5);
  });

  it('charges a shared bus twice for a memory-to-memory copy, a duplex bus once per lane', () => {
    const shared = base([once('c', [{ id: 'x', kind: 'transfer', from: 'ddr', to: 'sram', bytes: '1 MB' }])]);
    shared.memories[0].bandwidth = '100 GB/s';
    const r1 = run(shared);
    // Read and write legs both cross the 16 GB/s NoC: effective 8 GB/s. Latency: 100+10+10+0 ns.
    expect(wp(r1, 'c').response.max).toBe(120 * NS + 125 * US);

    const duplex = structuredClone(shared);
    duplex.buses[0].duplex = true;
    const r2 = run(duplex);
    expect(wp(r2, 'c').response.max).toBe(120 * NS + 62.5 * US);
    expect(res(r2, 'noc:rd').bytes).toBeCloseTo(1e6, 3);
    expect(res(r2, 'noc:wr').bytes).toBeCloseTo(1e6, 3);
  });

  it('queues transfers for a free DMA channel', () => {
    const m = base([
      once('a', [
        { id: 'x', kind: 'transfer', from: 'ddr', to: 'sram', bytes: '1 MB', via: 'dma' },
        { id: 'y', kind: 'transfer', from: 'ddr', to: 'sram', bytes: '1 MB', via: 'dma' },
      ]),
    ]);
    m.dmas![0].channels = 1;
    m.memories[0].bandwidth = '100 GB/s';
    const r = run(m);
    // Serialised: 2 x (120 ns + 1 MB / 8 GB/s).
    expect(wp(r, 'a').response.max).toBe(2 * (120 * NS + 125 * US));
    expect(wp(r, 'a').breakdown['DMA wait @dma']).toBe(120 * NS + 125 * US);
  });
});

describe('processor scheduling', () => {
  const periodic = (id: string, c: string, t: string, prio: number): WorkplanSpec => ({
    id,
    priority: prio,
    deadline: t,
    trigger: { type: 'periodic', period: t },
    steps: [{ id: 'run', kind: 'compute', on: 'cpu', cycles: c }],
  });

  it('matches response-time analysis for preemptive fixed priority', () => {
    const m = base([periodic('t1', '1 ms', '4 ms', 3), periodic('t2', '2 ms', '6 ms', 2), periodic('t3', '3 ms', '12 ms', 1)]);
    m.processors[0] = { id: 'cpu', freq: '1 GHz', policy: 'fixed-priority', preemptive: true };
    m.sim.duration = '48 ms';
    const r = run(m);
    // R1 = 1, R2 = 2 + 1 = 3, R3 = 3 + 3x1 + 2x2 = 10 (classic RTA fixed point).
    expect(wp(r, 't1').response.max).toBe(1 * MS);
    expect(wp(r, 't2').response.max).toBe(3 * MS);
    expect(wp(r, 't3').response.max).toBe(10 * MS);
    expect(wp(r, 't3').missed).toBe(0);
    expect(res(r, 'cpu').utilization).toBeCloseTo(1 / 4 + 2 / 6 + 3 / 12, 9);
  });

  it('meets every deadline at 100% utilization under EDF but not rate-monotonic', () => {
    const tasks = [periodic('a', '2 ms', '4 ms', 2), periodic('b', '3 ms', '6 ms', 1)];
    const edf = base(tasks);
    edf.processors[0] = { id: 'cpu', freq: '1 GHz', policy: 'edf', preemptive: true };
    edf.sim.duration = '120 ms';
    const r1 = run(edf);
    expect(wp(r1, 'a').missed + wp(r1, 'b').missed).toBe(0);

    const rm = structuredClone(edf);
    rm.processors[0].policy = 'fixed-priority';
    const r2 = run(rm);
    expect(wp(r2, 'b').missed).toBeGreaterThan(0);
  });

  it('never preempts on a non-preemptive block and charges context switches', () => {
    const m = base([
      once('long', [{ id: 'x', kind: 'compute', on: 'cpu', cycles: 1_000_000 }], { priority: 1 }),
      { ...once('urgent', [{ id: 'x', kind: 'compute', on: 'cpu', cycles: 1000 }], { priority: 9 }), trigger: { type: 'times', times: ['10 us'] } },
    ]);
    m.processors[0] = { id: 'cpu', freq: '1 GHz', policy: 'fixed-priority', preemptive: false, contextSwitch: '1 us' };
    const r = run(m);
    // long: 1 us switch + 1 ms. urgent waits for it, then 1 us switch + 1 us.
    expect(wp(r, 'long').response.max).toBe(1 * US + 1 * MS);
    expect(wp(r, 'urgent').response.max).toBe(1 * US + 1 * MS - 10 * US + 2 * US);
  });

  it('runs a fork-join DAG in parallel on two cores', () => {
    const m = base([
      once('dag', [
        { id: 'a', kind: 'compute', on: 'cpu', cycles: '1 ms' },
        { id: 'b', kind: 'compute', on: 'cpu', cycles: '2 ms', after: ['a'] },
        { id: 'c', kind: 'compute', on: 'cpu', cycles: '3 ms', after: ['a'] },
        { id: 'd', kind: 'compute', on: 'cpu', cycles: '1 ms', after: ['b', 'c'] },
      ]),
    ]);
    m.processors[0].cores = 2;
    const r = run(m);
    expect(wp(r, 'dag').response.max).toBe(5 * MS);
    expect(wp(r, 'dag').worst!.path.map((p) => p.step)).toEqual(['a', 'c', 'd']);
  });
});

describe('triggers and jobs', () => {
  it('joins two sources with an all-trigger and tracks end-to-end origin', () => {
    const r = run(
      base([
        { id: 'cam', trigger: { type: 'periodic', period: '1 ms' }, steps: [{ id: 'x', kind: 'delay', time: '100 us' }] },
        { id: 'radar', trigger: { type: 'periodic', period: '2 ms' }, steps: [{ id: 'x', kind: 'delay', time: '300 us' }] },
        {
          id: 'fuse',
          trigger: { type: 'event', sources: ['cam', 'radar'], mode: 'all' },
          steps: [{ id: 'x', kind: 'delay', time: '50 us' }],
        },
      ]),
    );
    const fuse = wp(r, 'fuse');
    // Radar paces the join: one fusion per 2 ms over 10 ms (t = 0, 2, ..., 10 ms releases, the last cut off).
    expect(fuse.completed).toBe(5);
    // First fusion: cam token from t=0 (origin 0) and radar from t=0 → fires at 300 us, done at 350 us.
    expect(fuse.jobs[0].origin).toBe(0);
    expect(fuse.jobs[0].completion).toBe(350 * US);
  });

  it('decimates with every: n', () => {
    const r = run(
      base([
        { id: 'src', trigger: { type: 'periodic', period: '1 ms' }, steps: [] },
        { id: 'slow', trigger: { type: 'event', sources: ['src'], every: 4 }, steps: [{ id: 'x', kind: 'delay', time: '1 us' }] },
      ]),
    );
    expect(wp(r, 'src').completed).toBe(11);
    expect(wp(r, 'slow').completed).toBe(2);
  });

  it('skips activations beyond maxInFlight', () => {
    const r = run(
      base([
        {
          id: 'w',
          maxInFlight: 1,
          onOverrun: 'skip',
          trigger: { type: 'periodic', period: '1 ms' },
          steps: [{ id: 'x', kind: 'delay', time: '2.5 ms' }],
        },
      ]),
    );
    // Activations at 0..10 ms; each job blocks the next two.
    expect(wp(r, 'w').activations).toBe(11);
    expect(wp(r, 'w').released).toBe(4);
    expect(wp(r, 'w').skipped).toBe(7);
  });

  it('counts jobs running past their deadline at the end as missed', () => {
    const r = run(base([once('w', [{ id: 'x', kind: 'delay', time: '20 ms' }], { deadline: '5 ms' })]));
    expect(wp(r, 'w').missed).toBe(1);
    expect(wp(r, 'w').incomplete).toBe(1);
  });

  it('evaluates per-job variables, in_bytes and distributions reproducibly', () => {
    const m = base([
      {
        id: 'w',
        vars: { n: 'round(uniform(1, 10))' },
        trigger: { type: 'periodic', period: '100 us' },
        steps: [
          { id: 'rd', kind: 'transfer', from: 'ddr', to: 'cpu', bytes: 'n * 1 KiB' },
          { id: 'go', kind: 'compute', on: 'cpu', cycles: 'in_bytes * 2', after: ['rd'] },
        ],
      },
    ]);
    const a = run(m);
    const b = run(m);
    expect(a.workplans[0].response).toEqual(b.workplans[0].response);
    const go = a.workplans[0].steps[1];
    const rd = a.workplans[0].steps[0];
    // 2 cycles per byte at 1 GHz: mean service = 2 * mean bytes ps... in ns.
    expect(go.service.mean).toBeCloseTo(rd.meanBytes * 2 * 1000, 0);
    expect(rd.meanBytes).toBeGreaterThan(1024);
    expect(rd.meanBytes).toBeLessThan(10 * 1024);
  });

  it('tracks buffer footprint from transfer start until the consumer finishes', () => {
    const r = run(
      base([
        once('w', [
          { id: 'in', kind: 'transfer', from: 'ddr', to: 'sram', via: 'dma', bytes: '256 KiB' },
          { id: 'use', kind: 'compute', on: 'cpu', cycles: '1 ms', after: ['in'] },
        ]),
      ]),
    );
    const f = r.footprints.find((x) => x.id === 'sram')!;
    expect(f.peak).toBe(256 * 1024);
    expect(f.series.v[f.series.v.length - 1]).toBe(0);
  });
});

describe('validation', () => {
  it('reports unit mistakes, unknown ids and cycles with paths', () => {
    const m = base([
      once('w', [
        { id: 'a', kind: 'compute', on: 'nope', cycles: 10, after: ['b'] },
        { id: 'b', kind: 'compute', on: 'cpu', cycles: 10, after: ['a'] },
      ]),
    ]);
    m.memories[0].readLatency = '100';
    const r = runModel(m);
    expect(r.ok).toBe(false);
    const msgs = !r.ok ? r.issues!.map((i) => `${i.path}: ${i.message}`) : [];
    expect(msgs.some((s) => s.startsWith('memories.ddr.readLatency') && s.includes('needs a unit'))).toBe(true);
    expect(msgs.some((s) => s.startsWith('workplans.w.steps.a.on'))).toBe(true);
    expect(msgs.some((s) => s.includes('dependency cycle'))).toBe(true);
  });
});

describe('peakWindowAverage', () => {
  it('finds the busiest window of a piecewise-constant signal exactly', () => {
    // 0 on [0,10), 1 on [10,12), 0.5 on [12,20), 0 on [20,100)
    const t = [0, 10, 12, 20];
    const v = [0, 1, 0.5, 0];
    expect(peakWindowAverage(t, v, 100, 4)).toBeCloseTo((2 + 1) / 4, 12);
    expect(peakWindowAverage(t, v, 100, 100)).toBeCloseTo(6 / 100, 12);
    expect(peakWindowAverage(t, v, 100, 1)).toBe(1);
  });
});

describe('poisson trigger', () => {
  it('draws exponential gaps with the requested mean', () => {
    const r = run(
      base(
        [{ id: 'p', trigger: { type: 'poisson', interval: '100 us' }, steps: [{ id: 'x', kind: 'delay', time: '1 us' }] }],
        { sim: { duration: '1 s', seed: 5 } },
      ),
    );
    const jobs = wp(r, 'p').jobs;
    const gaps = jobs.slice(1).map((j, i) => j.activation - jobs[i].activation);
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const cv = Math.sqrt(gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length) / mean;
    // ~10k arrivals: mean within 3%, coefficient of variation ≈ 1 for an exponential.
    expect(mean / (100 * US)).toBeGreaterThan(0.97);
    expect(mean / (100 * US)).toBeLessThan(1.03);
    expect(cv).toBeGreaterThan(0.95);
    expect(cv).toBeLessThan(1.05);
  });
});
