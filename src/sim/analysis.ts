import { PS_PER_S, type CompiledModel, type CWorkplan } from '../model/compile';
import { evalExpr, toBase, toWork, withRng } from '../model/expr';

/**
 * Contention-free, expected-value analysis of a compiled model. Every distribution is
 * replaced by its mean, so this is what the architecture must sustain *on average*;
 * the simulation then shows what queueing, bursts and jitter add on top.
 */

export interface RateInfo {
  id: string;
  /** Activations per second, or null when it cannot be derived (e.g. a trigger cycle). */
  hz: number | null;
  note: string;
}

export interface Demand {
  id: string;
  name: string;
  kind: 'processor' | 'memory' | 'bus' | 'dma';
  /** Bytes/s for memories and buses, cores or channels otherwise. */
  capacity: number;
  demand: number;
  utilization: number;
  byWorkplan: { id: string; value: number }[];
}

export interface Bound {
  id: string;
  /** Longest path through the DAG with every step running alone at its nominal duration. */
  lowerBoundPs: number;
  deadlinePs: number | null;
  path: { step: string; ps: number }[];
}

export interface Analysis {
  rates: RateInfo[];
  demand: Demand[];
  bounds: Bound[];
  errors: string[];
}

interface Nominal {
  durations: number[];
  cyclesPs: (number | null)[];
  bytes: number[];
}

function nominalJob(cm: CompiledModel, wp: CWorkplan): Nominal {
  return withRng(null, 'mean', () => {
    const scope: Record<string, unknown> = { ...cm.params, job: 0, t: 0, in_bytes: 0 };
    for (const v of wp.vars) scope[v.name] = evalExpr(v.expr, scope);
    const durations: number[] = new Array(wp.steps.length).fill(0);
    const cyclesPs: (number | null)[] = new Array(wp.steps.length).fill(null);
    const bytes: number[] = new Array(wp.steps.length).fill(0);
    for (const i of wp.topo) {
      const s = wp.steps[i];
      if (s.kind === 'transfer') {
        const b = toBase(evalExpr(s.bytes, scope), 'bytes');
        bytes[i] = b;
        const stream = b > 0 && Number.isFinite(s.path.idealBps) ? (b / s.path.idealBps) * PS_PER_S : 0;
        durations[i] = s.path.latencyPs + stream;
      } else if (s.kind === 'compute') {
        scope.in_bytes = s.preds.reduce((a, p) => a + (wp.steps[p].kind === 'transfer' ? bytes[p] : 0), 0);
        const w = toWork(evalExpr(s.cycles, scope));
        const proc = cm.processors[s.proc];
        const exec = 'cycles' in w ? (w.cycles / proc.freqHz) * PS_PER_S : w.seconds * PS_PER_S;
        cyclesPs[i] = exec + proc.ctxPs;
        durations[i] = exec + proc.ctxPs;
      } else {
        durations[i] = toBase(evalExpr(s.time, scope), 'time') * PS_PER_S;
      }
    }
    return { durations, cyclesPs, bytes };
  });
}

export function analyze(cm: CompiledModel): Analysis {
  const errors: string[] = [];
  const T = cm.durationPs / PS_PER_S;

  // ---- activation rates (fixed point over event-trigger chains) --------------
  const hz: (number | null)[] = cm.workplans.map(() => null);
  const notes: string[] = cm.workplans.map(() => '');
  cm.workplans.forEach((wp, i) => {
    const tr = wp.trigger;
    if (tr.type === 'periodic') {
      hz[i] = (Number.isFinite(tr.count) ? Math.min(1 / (tr.periodPs / PS_PER_S), tr.count / T) : PS_PER_S / tr.periodPs) * tr.repeat;
      notes[i] = `every ${fmtS(tr.periodPs / PS_PER_S)}`;
    } else if (tr.type === 'poisson') {
      try {
        const mean = withRng(null, 'mean', () => toBase(evalExpr(tr.interval, { ...cm.params, job: 0 }), 'time'));
        hz[i] = tr.repeat / Math.max(mean, tr.minPs / PS_PER_S);
        notes[i] = `Poisson, mean gap ${fmtS(Math.max(mean, tr.minPs / PS_PER_S))}`;
      } catch (e) {
        errors.push(`${wp.id}: ${(e as Error).message}`);
      }
    } else if (tr.type === 'times') {
      hz[i] = (tr.timesPs.filter((t) => t <= cm.durationPs).length / T) * tr.repeat;
      notes[i] = `${tr.timesPs.length} fixed times`;
    }
  });
  for (let iter = 0; iter < cm.workplans.length + 1; iter++) {
    cm.workplans.forEach((wp, i) => {
      const tr = wp.trigger;
      if (tr.type !== 'event' || hz[i] !== null) return;
      const src = tr.sources.map((s) => hz[s.wp]);
      if (src.some((x) => x === null)) return;
      const r = tr.mode === 'all' ? Math.min(...(src as number[])) : (src as number[]).reduce((a, b) => a + b, 0);
      hz[i] = (r / tr.every) * tr.repeat;
      const names = tr.sources.map((s) => cm.workplans[s.wp].id + (s.step >= 0 ? `.${cm.workplans[s.wp].steps[s.step].id}` : ''));
      notes[i] = `on ${tr.mode === 'all' ? 'all of' : ''} ${names.join(', ')}${tr.every > 1 ? `, every ${tr.every}` : ''}`;
    });
  }
  cm.workplans.forEach((wp, i) => {
    if (hz[i] === null && !notes[i]) notes[i] = 'rate undefined (trigger cycle)';
    if (wp.trigger.repeat > 1) notes[i] += ` ×${wp.trigger.repeat} per firing`;
    if (wp.maxInFlight !== Infinity) notes[i] += `; at most ${wp.maxInFlight} in flight`;
  });

  // ---- per-resource demand ----------------------------------------------------
  const proc = cm.processors.map(() => new Map<string, number>());
  const link = cm.resources.map(() => new Map<string, number>());
  const dma = cm.dmas.map(() => new Map<string, number>());
  const bounds: Bound[] = [];
  const bump = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);

  cm.workplans.forEach((wp, i) => {
    let nom: Nominal;
    try {
      nom = nominalJob(cm, wp);
    } catch (e) {
      errors.push(`${wp.id}: ${(e as Error).message}`);
      return;
    }
    const rate = hz[i] ?? 0;
    wp.steps.forEach((s, j) => {
      if (s.kind === 'compute') bump(proc[s.proc], wp.id, (rate * nom.durations[j]) / PS_PER_S);
      else if (s.kind === 'transfer') {
        for (const u of s.path.usage) bump(link[u.res], wp.id, rate * nom.bytes[j] * u.coef);
        if (s.path.dma >= 0) bump(dma[s.path.dma], wp.id, (rate * nom.durations[j]) / PS_PER_S);
      }
    });
    // Longest path in the DAG (steps are in topological order).
    const finish = new Array(wp.steps.length).fill(0);
    const via = new Array(wp.steps.length).fill(-1);
    for (const j of wp.topo) {
      let startAt = 0;
      for (const p of wp.steps[j].preds) {
        if (finish[p] > startAt) {
          startAt = finish[p];
          via[j] = p;
        }
      }
      finish[j] = startAt + nom.durations[j];
    }
    let last = -1;
    finish.forEach((f, j) => {
      if (last < 0 || f > finish[last]) last = j;
    });
    const path: Bound['path'] = [];
    for (let j = last; j >= 0; j = via[j]) path.unshift({ step: wp.steps[j].id, ps: nom.durations[j] });
    bounds.push({ id: wp.id, lowerBoundPs: last >= 0 ? finish[last] : 0, deadlinePs: wp.deadlinePs, path });
  });

  const rows = (m: Map<string, number>) =>
    [...m].map(([id, value]) => ({ id, value })).sort((a, b) => b.value - a.value);
  const total = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);

  const demand: Demand[] = [
    ...cm.processors.map((p, i) => ({
      id: p.id,
      name: p.name,
      kind: 'processor' as const,
      capacity: p.cores,
      demand: total(proc[i]),
      utilization: total(proc[i]) / p.cores,
      byWorkplan: rows(proc[i]),
    })),
    ...cm.resources.map((r, i) => ({
      id: r.id,
      name: `${r.ownerKind === 'memory' ? cm.memories[cm.kinds.get(r.owner)!.idx].name : cm.buses[cm.kinds.get(r.owner)!.idx].name}${r.lane === 'rd' ? ' (read)' : r.lane === 'wr' ? ' (write)' : ''}`,
      kind: r.ownerKind,
      capacity: r.capBps,
      demand: total(link[i]),
      utilization: total(link[i]) / r.capBps,
      byWorkplan: rows(link[i]),
    })),
    ...cm.dmas.map((d, i) => ({
      id: d.id,
      name: d.name,
      kind: 'dma' as const,
      capacity: d.channels,
      demand: total(dma[i]),
      utilization: total(dma[i]) / d.channels,
      byWorkplan: rows(dma[i]),
    })),
  ];

  return {
    rates: cm.workplans.map((wp, i) => ({ id: wp.id, hz: hz[i], note: notes[i].trim() })),
    demand,
    bounds,
    errors,
  };
}

function fmtS(s: number): string {
  if (s >= 1) return `${+s.toPrecision(3)} s`;
  if (s >= 1e-3) return `${+(s * 1e3).toPrecision(3)} ms`;
  if (s >= 1e-6) return `${+(s * 1e6).toPrecision(3)} µs`;
  return `${+(s * 1e9).toPrecision(3)} ns`;
}
