import { compileExpr, evaluate, ExprError, toBase, type CExpr, type Quantity } from './expr';
import type { ComponentKind, Expr, Model, SchedPolicy, StepSpec, TriggerSpec } from './types';

/** Simulation time is integer picoseconds: exact up to ~2.5 hours of simulated time. */
export const PS_PER_S = 1e12;
export const sToPs = (s: number) => Math.round(s * PS_PER_S);

export interface Issue {
  path: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface CProcessor {
  idx: number;
  id: string;
  name: string;
  freqHz: number;
  cores: number;
  policy: SchedPolicy;
  preemptive: boolean;
  ctxPs: number;
  maxOutstanding: number | null;
  burst: number | null;
}

export interface CMemory {
  idx: number;
  id: string;
  name: string;
  sizeBytes: number;
  bwBps: number;
  readLatPs: number;
  writeLatPs: number;
  duplex: boolean;
  resRead: number;
  resWrite: number;
}

export interface CBus {
  idx: number;
  id: string;
  name: string;
  bwBps: number;
  latPs: number;
  duplex: boolean;
  resRead: number;
  resWrite: number;
}

export interface CDma {
  idx: number;
  id: string;
  name: string;
  channels: number;
  maxOutstanding: number | null;
  burst: number | null;
  policy: 'fifo' | 'priority';
}

/** A bandwidth-limited resource in the fluid network: a memory or bus lane. */
export interface CResource {
  idx: number;
  id: string;
  owner: string;
  ownerKind: 'memory' | 'bus';
  lane: 'rw' | 'rd' | 'wr';
  capBps: number;
}

export interface CTransferPath {
  initiator: string;
  readHops: string[];
  writeHops: string[];
  /** Bytes consumed on each resource per byte moved (2 when a shared bus carries both legs). */
  usage: { res: number; coef: number }[];
  latencyPs: number;
  /** Rate cap from the initiator's outstanding-transaction limit (bytes/s), Infinity if none. */
  capBps: number;
  /** The uncontended streaming rate: min of the cap and every resource's share. */
  idealBps: number;
  dma: number;
  srcMem: number;
  dstMem: number;
}

interface CStepBase {
  idx: number;
  id: string;
  name: string;
  preds: number[];
  succs: number[];
  priority: number;
  deadlinePs: number | null;
}

export interface CComputeStep extends CStepBase {
  kind: 'compute';
  proc: number;
  cycles: CExpr;
}

export interface CTransferStep extends CStepBase {
  kind: 'transfer';
  bytes: CExpr;
  path: CTransferPath;
  weight: number;
}

export interface CDelayStep extends CStepBase {
  kind: 'delay';
  time: CExpr;
}

export type CStep = CComputeStep | CTransferStep | CDelayStep;

export type CTrigger =
  | { type: 'periodic'; periodPs: number; offsetPs: number; jitter: CExpr | null; count: number }
  | { type: 'poisson'; interval: CExpr; minPs: number; count: number }
  | { type: 'event'; sources: { wp: number; step: number }[]; mode: 'any' | 'all'; every: number; delay: CExpr | null }
  | { type: 'times'; timesPs: number[] };

export interface CWorkplan {
  idx: number;
  id: string;
  name: string;
  trigger: CTrigger;
  deadlinePs: number | null;
  e2eDeadlinePs: number | null;
  priority: number;
  maxInFlight: number;
  onOverrun: 'skip' | 'queue';
  vars: { name: string; expr: CExpr }[];
  steps: CStep[];
  roots: number[];
  topo: number[];
}

export interface CompiledModel {
  params: Record<string, unknown>;
  processors: CProcessor[];
  memories: CMemory[];
  buses: CBus[];
  dmas: CDma[];
  resources: CResource[];
  workplans: CWorkplan[];
  kinds: Map<string, { kind: ComponentKind; idx: number }>;
  durationPs: number;
  seed: number;
  utilWindowPs: number;
  traceLimit: number;
  arbitration: 'priority' | 'fair';
}

export interface CompileOptions {
  /** Replaces param values (numbers or expression strings); used by sweeps. */
  paramOverrides?: Record<string, Expr>;
}

export type CompileResult = { ok: true; model: CompiledModel; issues: Issue[] } | { ok: false; issues: Issue[] };

const ID_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const RESERVED = new Set(['job', 't', 'in_bytes']);

export function compile(model: Model, options: CompileOptions = {}): CompileResult {
  const issues: Issue[] = [];
  const err = (path: string, message: string) => issues.push({ path, message, severity: 'error' });
  const warn = (path: string, message: string) => issues.push({ path, message, severity: 'warning' });

  // ---- params -------------------------------------------------------------
  const params: Record<string, unknown> = {};
  const rawParams = { ...(model.params ?? {}), ...(options.paramOverrides ?? {}) };
  for (const [name, e] of Object.entries(rawParams)) {
    if (!ID_RE.test(name) || name.includes('-')) {
      err(`params.${name}`, 'parameter names must be identifiers (letters, digits, _)');
      continue;
    }
    if (RESERVED.has(name)) {
      err(`params.${name}`, `"${name}" is reserved`);
      continue;
    }
    try {
      params[name] = evaluate(e, params);
    } catch (e2) {
      err(`params.${name}`, (e2 as Error).message);
    }
  }

  /** Evaluates a static field into base units, recording an issue on failure. */
  const num = (path: string, e: Expr | undefined, q: Quantity, fallback?: number): number => {
    if (e === undefined || e === '') {
      if (fallback !== undefined) return fallback;
      err(path, 'is required');
      return NaN;
    }
    try {
      return toBase(evaluate(e, params), q);
    } catch (e2) {
      err(path, e2 instanceof ExprError ? e2.message : String(e2));
      return NaN;
    }
  };
  const positive = (path: string, v: number) => {
    if (Number.isFinite(v) && v <= 0) err(path, 'must be greater than zero');
    return v;
  };
  const nonNeg = (path: string, v: number) => {
    if (Number.isFinite(v) && v < 0) err(path, 'must not be negative');
    return v;
  };

  // ---- components -------------------------------------------------------
  const kinds = new Map<string, { kind: ComponentKind; idx: number }>();
  const claim = (path: string, id: string, kind: ComponentKind, idx: number) => {
    if (!id || !ID_RE.test(id)) err(path, `"${id}" is not a valid id (letters, digits, _ and -; not starting with a digit)`);
    else if (kinds.has(id)) err(path, `duplicate id "${id}"`);
    else kinds.set(id, { kind, idx });
  };

  const resources: CResource[] = [];
  const addRes = (owner: string, ownerKind: 'memory' | 'bus', lane: CResource['lane'], capBps: number) => {
    const idx = resources.length;
    resources.push({ idx, id: lane === 'rw' ? owner : `${owner}:${lane}`, owner, ownerKind, lane, capBps });
    return idx;
  };

  const processors: CProcessor[] = model.processors.map((p, idx) => {
    const path = `processors.${p.id}`;
    claim(path, p.id, 'processor', idx);
    const cores = num(`${path}.cores`, p.cores, 'count', 1);
    if (Number.isFinite(cores) && (cores < 1 || !Number.isInteger(cores))) err(`${path}.cores`, 'must be a whole number ≥ 1');
    return {
      idx,
      id: p.id,
      name: p.name || p.id,
      freqHz: positive(`${path}.freq`, num(`${path}.freq`, p.freq, 'freq')),
      cores,
      policy: p.policy ?? 'fifo',
      preemptive: p.preemptive ?? false,
      ctxPs: sToPs(nonNeg(`${path}.contextSwitch`, num(`${path}.contextSwitch`, p.contextSwitch, 'time', 0))),
      maxOutstanding: p.maxOutstanding === undefined || p.maxOutstanding === '' ? null : num(`${path}.maxOutstanding`, p.maxOutstanding, 'count'),
      burst: p.burst === undefined || p.burst === '' ? null : num(`${path}.burst`, p.burst, 'bytes'),
    };
  });

  const memories: CMemory[] = model.memories.map((m, idx) => {
    const path = `memories.${m.id}`;
    claim(path, m.id, 'memory', idx);
    const bwBps = positive(`${path}.bandwidth`, num(`${path}.bandwidth`, m.bandwidth, 'bandwidth'));
    const readLatPs = sToPs(nonNeg(`${path}.readLatency`, num(`${path}.readLatency`, m.readLatency, 'time')));
    const duplex = m.duplex ?? false;
    const resRead = addRes(m.id, 'memory', duplex ? 'rd' : 'rw', bwBps);
    const resWrite = duplex ? addRes(m.id, 'memory', 'wr', bwBps) : resRead;
    return {
      idx,
      id: m.id,
      name: m.name || m.id,
      sizeBytes: positive(`${path}.size`, num(`${path}.size`, m.size, 'bytes')),
      bwBps,
      readLatPs,
      writeLatPs:
        m.writeLatency === undefined || m.writeLatency === ''
          ? readLatPs
          : sToPs(nonNeg(`${path}.writeLatency`, num(`${path}.writeLatency`, m.writeLatency, 'time'))),
      duplex,
      resRead,
      resWrite,
    };
  });

  const buses: CBus[] = model.buses.map((b, idx) => {
    const path = `buses.${b.id}`;
    claim(path, b.id, 'bus', idx);
    let bwBps: number;
    if (b.bandwidth !== undefined && b.bandwidth !== '') {
      bwBps = num(`${path}.bandwidth`, b.bandwidth, 'bandwidth');
    } else if (b.width !== undefined && b.freq !== undefined) {
      const width = num(`${path}.width`, b.width, 'bytes');
      const freq = num(`${path}.freq`, b.freq, 'freq');
      const eff = num(`${path}.efficiency`, b.efficiency, 'count', 1);
      if (Number.isFinite(eff) && (eff <= 0 || eff > 1)) err(`${path}.efficiency`, 'must be in (0, 1]');
      bwBps = width * freq * eff;
    } else {
      err(`${path}.bandwidth`, 'give either bandwidth, or width and freq');
      bwBps = NaN;
    }
    positive(`${path}.bandwidth`, bwBps);
    const duplex = b.duplex ?? false;
    const resRead = addRes(b.id, 'bus', duplex ? 'rd' : 'rw', bwBps);
    const resWrite = duplex ? addRes(b.id, 'bus', 'wr', bwBps) : resRead;
    return {
      idx,
      id: b.id,
      name: b.name || b.id,
      bwBps,
      latPs: sToPs(nonNeg(`${path}.latency`, num(`${path}.latency`, b.latency, 'time', 0))),
      duplex,
      resRead,
      resWrite,
    };
  });

  const dmas: CDma[] = (model.dmas ?? []).map((d, idx) => {
    const path = `dmas.${d.id}`;
    claim(path, d.id, 'dma', idx);
    const channels = num(`${path}.channels`, d.channels, 'count', 1);
    if (Number.isFinite(channels) && (channels < 1 || !Number.isInteger(channels))) err(`${path}.channels`, 'must be a whole number ≥ 1');
    return {
      idx,
      id: d.id,
      name: d.name || d.id,
      channels,
      maxOutstanding: d.maxOutstanding === undefined || d.maxOutstanding === '' ? null : num(`${path}.maxOutstanding`, d.maxOutstanding, 'count'),
      burst: d.burst === undefined || d.burst === '' ? null : num(`${path}.burst`, d.burst, 'bytes'),
      policy: d.policy ?? 'fifo',
    };
  });

  // ---- topology -----------------------------------------------------------
  const adj = new Map<string, Set<string>>();
  for (const id of kinds.keys()) adj.set(id, new Set());
  model.links.forEach(([a, b], i) => {
    const path = `links[${i}]`;
    if (!kinds.has(a)) return err(path, `unknown component "${a}"`);
    if (!kinds.has(b)) return err(path, `unknown component "${b}"`);
    if (a === b) return err(path, 'a component cannot link to itself');
    adj.get(a)!.add(b);
    adj.get(b)!.add(a);
  });
  for (const [id, info] of kinds) {
    if (info.kind === 'bus' && adj.get(id)!.size === 0) warn(`buses.${id}`, 'is not linked to anything');
  }

  const kindOf = (id: string) => kinds.get(id)?.kind;
  const latOf = (busId: string) => buses[kinds.get(busId)!.idx].latPs;

  /** Fewest-hop route from a to b where every intermediate node is a bus. */
  const route = (a: string, b: string): string[] | null => {
    if (a === b) return [];
    const prev = new Map<string, string | null>([[a, null]]);
    const queue = [a];
    while (queue.length) {
      const cur = queue.shift()!;
      // Deterministic order: sort neighbours so ties resolve the same way every run.
      for (const n of [...adj.get(cur)!].sort()) {
        if (prev.has(n)) continue;
        prev.set(n, cur);
        if (n === b) {
          const hops: string[] = [];
          for (let x = prev.get(b)!; x !== a && x !== null; x = prev.get(x)!) hops.unshift(x);
          return hops;
        }
        if (kindOf(n) === 'bus') queue.push(n);
      }
    }
    return null;
  };

  const transferPath = (path: string, s: { from: string; to: string; via?: string }): CTransferPath | null => {
    const fk = kindOf(s.from);
    const tk = kindOf(s.to);
    let ok = true;
    if (fk !== 'memory' && fk !== 'processor') {
      err(`${path}.from`, fk ? `"${s.from}" is a ${fk}; transfers move data between memories and processors` : `unknown component "${s.from}"`);
      ok = false;
    }
    if (tk !== 'memory' && tk !== 'processor') {
      err(`${path}.to`, tk ? `"${s.to}" is a ${tk}; transfers move data between memories and processors` : `unknown component "${s.to}"`);
      ok = false;
    }
    if (!ok) return null;
    if (s.from === s.to) {
      err(`${path}.to`, 'source and destination are the same');
      return null;
    }
    let initiator = s.via;
    if (initiator) {
      const vk = kindOf(initiator);
      if (vk !== 'dma' && vk !== 'processor') {
        err(`${path}.via`, vk ? `"${initiator}" is a ${vk}; via must be a DMA or processor` : `unknown component "${initiator}"`);
        return null;
      }
    } else if (fk === 'processor') initiator = s.from;
    else if (tk === 'processor') initiator = s.to;
    else if (dmas.length === 1) initiator = dmas[0].id;
    else {
      err(`${path}.via`, 'a memory-to-memory transfer needs a DMA or processor in "via"');
      return null;
    }
    const readHops = s.from === initiator ? [] : route(s.from, initiator);
    const writeHops = s.to === initiator ? [] : route(initiator, s.to);
    if (!readHops) {
      err(path, `no route from ${s.from} to ${initiator} through buses`);
      return null;
    }
    if (!writeHops) {
      err(path, `no route from ${initiator} to ${s.to} through buses`);
      return null;
    }
    const usage = new Map<number, number>();
    const use = (res: number) => usage.set(res, (usage.get(res) ?? 0) + 1);
    const srcMem = fk === 'memory' ? memories[kinds.get(s.from)!.idx] : null;
    const dstMem = tk === 'memory' ? memories[kinds.get(s.to)!.idx] : null;
    if (srcMem) use(srcMem.resRead);
    for (const h of readHops) use(buses[kinds.get(h)!.idx].resRead);
    for (const h of writeHops) use(buses[kinds.get(h)!.idx].resWrite);
    if (dstMem) use(dstMem.resWrite);

    const readHopLat = readHops.reduce((a, h) => a + latOf(h), 0);
    const writeHopLat = writeHops.reduce((a, h) => a + latOf(h), 0);
    const latencyPs = (srcMem?.readLatPs ?? 0) + readHopLat + writeHopLat + (dstMem?.writeLatPs ?? 0);

    const init = kinds.get(initiator)!;
    const src = init.kind === 'dma' ? dmas[init.idx] : processors[init.idx];
    let capBps = Infinity;
    if (src.maxOutstanding != null && src.burst != null) {
      const window = src.maxOutstanding * src.burst;
      const rttRead = 2 * readHopLat + (srcMem?.readLatPs ?? 0);
      const rttWrite = 2 * writeHopLat + (dstMem?.writeLatPs ?? 0);
      if ((readHops.length || srcMem) && rttRead > 0) capBps = Math.min(capBps, (window / rttRead) * PS_PER_S);
      if ((writeHops.length || dstMem) && rttWrite > 0) capBps = Math.min(capBps, (window / rttWrite) * PS_PER_S);
    }
    const usageArr = [...usage].map(([res, coef]) => ({ res, coef }));
    const idealBps = usageArr.reduce((m, u) => Math.min(m, resources[u.res].capBps / u.coef), capBps);
    return {
      initiator,
      readHops,
      writeHops,
      usage: usageArr,
      latencyPs,
      capBps,
      idealBps,
      dma: init.kind === 'dma' ? init.idx : -1,
      srcMem: srcMem?.idx ?? -1,
      dstMem: dstMem?.idx ?? -1,
    };
  };

  // ---- workplans ----------------------------------------------------------
  const wpIndex = new Map<string, number>();
  model.workplans.forEach((w, i) => {
    if (!w.id || !ID_RE.test(w.id)) err(`workplans.${w.id}`, `"${w.id}" is not a valid id`);
    else if (wpIndex.has(w.id)) err(`workplans.${w.id}`, `duplicate workplan id "${w.id}"`);
    else wpIndex.set(w.id, i);
  });

  const workplans: CWorkplan[] = model.workplans.map((w, idx) => {
    const path = `workplans.${w.id}`;
    const priority = w.priority ?? 0;
    const varNames = Object.keys(w.vars ?? {});
    const dynamic = new Set<string>(['job', 't']);
    const vars: CWorkplan['vars'] = [];
    for (const name of varNames) {
      if (!ID_RE.test(name) || name.includes('-') || RESERVED.has(name)) {
        err(`${path}.vars.${name}`, 'variable names must be identifiers and not job, t or in_bytes');
        continue;
      }
      try {
        vars.push({ name, expr: compileExpr(w.vars![name], params, dynamic) });
      } catch (e2) {
        err(`${path}.vars.${name}`, (e2 as Error).message);
      }
      dynamic.add(name);
    }
    dynamic.add('in_bytes');

    const stepIndex = new Map<string, number>();
    w.steps.forEach((s, i) => {
      if (!s.id || !ID_RE.test(s.id)) err(`${path}.steps.${s.id}`, `"${s.id}" is not a valid step id`);
      else if (stepIndex.has(s.id)) err(`${path}.steps.${s.id}`, `duplicate step id "${s.id}"`);
      else stepIndex.set(s.id, i);
    });

    const expr = (p: string, e: Expr | undefined): CExpr | null => {
      if (e === undefined || e === '') {
        err(p, 'is required');
        return null;
      }
      try {
        return compileExpr(e, params, dynamic);
      } catch (e2) {
        err(p, (e2 as Error).message);
        return null;
      }
    };

    const steps: CStep[] = w.steps.map((s: StepSpec, i): CStep => {
      const sp = `${path}.steps.${s.id}`;
      const preds: number[] = [];
      for (const a of s.after ?? []) {
        const j = stepIndex.get(a);
        if (j === undefined) err(`${sp}.after`, `unknown step "${a}"`);
        else if (j === i) err(`${sp}.after`, 'a step cannot depend on itself');
        else if (!preds.includes(j)) preds.push(j);
      }
      const base = {
        idx: i,
        id: s.id,
        name: s.name || s.id,
        preds,
        succs: [] as number[],
        priority: s.priority ?? priority,
        deadlinePs:
          s.deadline === undefined || s.deadline === '' ? null : sToPs(num(`${sp}.deadline`, s.deadline, 'time')),
      };
      if (s.kind === 'compute') {
        const pk = kindOf(s.on);
        if (pk !== 'processor') err(`${sp}.on`, pk ? `"${s.on}" is a ${pk}, not a processor` : `unknown processor "${s.on}"`);
        return { ...base, kind: 'compute', proc: pk === 'processor' ? kinds.get(s.on)!.idx : -1, cycles: expr(`${sp}.cycles`, s.cycles)! };
      }
      if (s.kind === 'transfer') {
        const p = transferPath(sp, s);
        if (s.weight !== undefined && !(s.weight > 0)) err(`${sp}.weight`, 'must be greater than zero');
        return {
          ...base,
          kind: 'transfer',
          bytes: expr(`${sp}.bytes`, s.bytes)!,
          path: p!,
          weight: s.weight ?? 1,
        };
      }
      if (s.kind === 'delay') return { ...base, kind: 'delay', time: expr(`${sp}.time`, s.time)! };
      err(sp, `unknown step kind "${(s as { kind: string }).kind}"`);
      return { ...base, kind: 'delay', time: { src: '0', constant: true, value: 0 } };
    });
    for (const s of steps) for (const p of s.preds) steps[p].succs.push(s.idx);

    // Kahn's algorithm: a topological order, or a cycle to report.
    const indeg = steps.map((s) => s.preds.length);
    const topo: number[] = [];
    const q = steps.filter((s) => s.preds.length === 0).map((s) => s.idx);
    while (q.length) {
      const i = q.shift()!;
      topo.push(i);
      for (const j of steps[i].succs) if (--indeg[j] === 0) q.push(j);
    }
    if (topo.length !== steps.length && steps.length) {
      const stuck = steps.filter((_, i) => indeg[i] > 0).map((s) => s.id);
      err(`${path}.steps`, `dependency cycle among: ${stuck.join(', ')}`);
    }
    if (steps.length === 0) warn(`${path}.steps`, 'has no steps');

    return {
      idx,
      id: w.id,
      name: w.name || w.id,
      trigger: compileTrigger(`${path}.trigger`, w.trigger),
      deadlinePs: w.deadline === undefined || w.deadline === '' ? null : sToPs(num(`${path}.deadline`, w.deadline, 'time')),
      e2eDeadlinePs:
        w.e2eDeadline === undefined || w.e2eDeadline === '' ? null : sToPs(num(`${path}.e2eDeadline`, w.e2eDeadline, 'time')),
      priority,
      maxInFlight: w.maxInFlight && w.maxInFlight > 0 ? w.maxInFlight : Infinity,
      onOverrun: w.onOverrun ?? 'skip',
      vars,
      steps,
      roots: steps.filter((s) => s.preds.length === 0).map((s) => s.idx),
      topo,
    };
  });

  function compileTrigger(path: string, t: TriggerSpec | undefined): CTrigger {
    const tExpr = (p: string, e: Expr | undefined): CExpr | null => {
      if (e === undefined || e === '' || e === 0 || e === '0') return null;
      try {
        return compileExpr(e, params, new Set(['job']));
      } catch (e2) {
        err(p, (e2 as Error).message);
        return null;
      }
    };
    if (!t) {
      err(path, 'is required');
      return { type: 'times', timesPs: [] };
    }
    switch (t.type) {
      case 'periodic':
        return {
          type: 'periodic',
          periodPs: sToPs(positive(`${path}.period`, num(`${path}.period`, t.period, 'time'))),
          offsetPs: sToPs(nonNeg(`${path}.offset`, num(`${path}.offset`, t.offset, 'time', 0))),
          jitter: tExpr(`${path}.jitter`, t.jitter),
          count: t.count && t.count > 0 ? t.count : Infinity,
        };
      case 'poisson': {
        const interval = tExpr(`${path}.interval`, t.interval);
        if (!interval) err(`${path}.interval`, 'is required and must be non-zero');
        return {
          type: 'poisson',
          interval: interval ?? { src: '0', constant: true, value: 0 },
          minPs: sToPs(nonNeg(`${path}.minInterval`, num(`${path}.minInterval`, t.minInterval, 'time', 0))),
          count: t.count && t.count > 0 ? t.count : Infinity,
        };
      }
      case 'event': {
        const sources: { wp: number; step: number }[] = [];
        for (const src of t.sources ?? []) {
          const [wpId, stepId] = src.split('.');
          const wi = wpIndex.get(wpId);
          if (wi === undefined) {
            err(`${path}.sources`, `unknown workplan "${wpId}"`);
            continue;
          }
          let si = -1;
          if (stepId !== undefined) {
            si = model.workplans[wi].steps.findIndex((s) => s.id === stepId);
            if (si < 0) {
              err(`${path}.sources`, `workplan "${wpId}" has no step "${stepId}"`);
              continue;
            }
          }
          sources.push({ wp: wi, step: si });
        }
        if (sources.length === 0) err(`${path}.sources`, 'an event trigger needs at least one source');
        const every = t.every && t.every >= 1 ? Math.floor(t.every) : 1;
        return { type: 'event', sources, mode: t.mode ?? 'any', every, delay: tExpr(`${path}.delay`, t.delay) };
      }
      case 'times':
        return {
          type: 'times',
          timesPs: (t.times ?? [])
            .map((e, i) => sToPs(nonNeg(`${path}.times[${i}]`, num(`${path}.times[${i}]`, e, 'time'))))
            .sort((a, b) => a - b),
        };
      default:
        err(path, `unknown trigger type "${(t as { type: string }).type}"`);
        return { type: 'times', timesPs: [] };
    }
  }

  // Self-triggering chains are legal (ping-pong), but a zero-work loop never advances time.
  const wpIdx = (w: number) => workplans[w];
  for (const w of workplans) {
    if (w.trigger.type !== 'event') continue;
    const seen = new Set<number>();
    const stack = w.trigger.sources.map((s) => s.wp);
    while (stack.length) {
      const x = stack.pop()!;
      if (x === w.idx) {
        warn(`workplans.${w.id}.trigger`, 'is part of a trigger cycle; make sure each lap takes time');
        break;
      }
      if (seen.has(x)) continue;
      seen.add(x);
      const tr = wpIdx(x)?.trigger;
      if (tr?.type === 'event') stack.push(...tr.sources.map((s) => s.wp));
    }
  }

  // ---- simulation settings -------------------------------------------------
  const durationPs = sToPs(positive('sim.duration', num('sim.duration', model.sim?.duration, 'time')));
  const utilWindowPs =
    model.sim?.utilWindow === undefined || model.sim.utilWindow === ''
      ? Math.max(1, Math.round(durationPs / 100))
      : sToPs(positive('sim.utilWindow', num('sim.utilWindow', model.sim.utilWindow, 'time')));

  if (issues.some((i) => i.severity === 'error')) return { ok: false, issues };
  return {
    ok: true,
    issues,
    model: {
      params,
      processors,
      memories,
      buses,
      dmas,
      resources,
      workplans,
      kinds,
      durationPs,
      seed: model.sim?.seed ?? 1,
      utilWindowPs,
      traceLimit: model.sim?.traceLimit ?? 200_000,
      arbitration: model.sim?.arbitration ?? 'priority',
    },
  };
}
