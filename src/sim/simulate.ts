import { compile, PS_PER_S, type CompiledModel, type CStep, type CWorkplan, type CompileOptions } from '../model/compile';
import { evalExpr, math, toBase, toWork, withRng, type CExpr } from '../model/expr';
import { hashString, Rng } from '../model/rng';
import type { Model } from '../model/types';
import { Fabric } from './fabric';
import { EventQueue } from './heap';
import { DmaSim, ProcessorSim, type Task } from './resources';
import type {
  FootprintResult,
  JobRecord,
  PathStep,
  ResourceResult,
  SimFailure,
  SimResult,
  StepStat,
  Summary,
  Trace,
  WorkplanResult,
} from './result';
import { peakWindowAverage, StepSeries } from './series';

export interface SimOptions {
  onProgress?: (fraction: number) => void;
  /** Abort after this many events (runaway protection). */
  maxEvents?: number;
  /** Skip timeline and series recording — used by sweeps, which only need statistics. */
  statsOnly?: boolean;
}

class SimError extends Error {}

interface StepInst {
  def: CStep;
  job: Job;
  pending: number;
  readyT: number;
  startT: number;
  streamT: number;
  endT: number;
  bytes: number;
  alloc: number;
  consumersLeft: number;
  critPred: number;
  task: Task | null;
}

interface Job {
  ws: WpState;
  idx: number;
  activation: number;
  release: number;
  origin: number;
  absDeadline: number;
  scope: Record<string, unknown>;
  steps: StepInst[];
  left: number;
  record: JobRecord;
}

interface StepAgg {
  wait: number[];
  service: number[];
  bytes: number;
  misses: number;
}

interface WpState {
  wp: CWorkplan;
  rng: Rng;
  trigRng: Rng;
  jobs: JobRecord[];
  inFlight: number;
  waiting: { activation: number; origin: number }[];
  activations: number;
  skipped: number;
  steps: StepAgg[];
  breakdown: Map<string, number>;
  worst: WorkplanResult['worst'];
  tokens: number[][];
}

export function summarize(values: number[]): Summary {
  const n = values.length;
  if (n === 0) return { count: 0, min: 0, mean: 0, p50: 0, p90: 0, p99: 0, max: 0, std: 0 };
  const sorted = Float64Array.from(values).sort();
  const arr = Array.from(sorted);
  const [p50, p90, p99] = math.quantileSeq(arr, [0.5, 0.9, 0.99], true) as number[];
  return {
    count: n,
    min: arr[0],
    mean: math.mean(arr) as number,
    p50,
    p90,
    p99,
    max: arr[n - 1],
    std: n > 1 ? (math.std(arr) as unknown as number) : 0,
  };
}

/** Compile and run in one go, turning every failure into a SimFailure. */
export function runModel(model: Model, options: SimOptions & CompileOptions = {}): SimResult | SimFailure {
  const c = compile(model, options);
  if (!c.ok) return { ok: false, error: 'The model has errors', issues: c.issues };
  try {
    const res = simulate(c.model, options);
    res.warnings.unshift(...c.issues.filter((i) => i.severity === 'warning').map((i) => `${i.path}: ${i.message}`));
    return res;
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export function simulate(cm: CompiledModel, opts: SimOptions = {}): SimResult {
  const t0 = performance.now();
  const q = new EventQueue();
  const T = cm.durationPs;
  const statsOnly = opts.statsOnly ?? false;
  const seriesLimit = statsOnly ? 2 : 100_000;
  const traceLimit = statsOnly ? 0 : cm.traceLimit;
  const maxEvents = opts.maxEvents ?? 50_000_000;
  const warnings: string[] = [];

  const fabric = new Fabric(
    q,
    cm.resources.map((r) => r.capBps / PS_PER_S),
    cm.arbitration === 'fair',
    seriesLimit,
  );
  const procs = cm.processors.map((p) => new ProcessorSim(p, q, seriesLimit));
  const dmas = cm.dmas.map((d) => new DmaSim(d, q, seriesLimit));
  const footprint = cm.memories.map(() => new StepSeries(seriesLimit));
  const footBytes = new Float64Array(cm.memories.length);
  const allocate = (mem: number, delta: number) => {
    footBytes[mem] += delta;
    if (Math.abs(footBytes[mem]) < 1e-6) footBytes[mem] = 0;
    footprint[mem].set(q.now, footBytes[mem]);
  };

  const trace: Trace = { compute: [], transfers: [], delays: [], truncated: false };
  let traced = 0;
  const canTrace = () => {
    if (traced < traceLimit) {
      traced++;
      return true;
    }
    if (!statsOnly) trace.truncated = true;
    return false;
  };

  let seq = 0;
  const states: WpState[] = cm.workplans.map((wp) => ({
    wp,
    rng: new Rng(cm.seed, hashString(`wp:${wp.id}`)),
    trigRng: new Rng(cm.seed, hashString(`trigger:${wp.id}`)),
    jobs: [],
    inFlight: 0,
    waiting: [],
    activations: 0,
    skipped: 0,
    steps: wp.steps.map(() => ({ wait: [], service: [], bytes: 0, misses: 0 })),
    breakdown: new Map(),
    worst: null,
    tokens: wp.trigger.type === 'event' ? wp.trigger.sources.map(() => []) : [],
  }));

  // Event-trigger listeners, keyed by source workplan and step (-1 = whole job).
  const listeners = new Map<string, { target: WpState; src: number }[]>();
  for (const ws of states) {
    const tr = ws.wp.trigger;
    if (tr.type !== 'event') continue;
    tr.sources.forEach((s, src) => {
      const key = `${s.wp}:${s.step}`;
      if (!listeners.has(key)) listeners.set(key, []);
      listeners.get(key)!.push({ target: ws, src });
    });
  }

  const fail = (job: Job, step: CStep | null, e: unknown): never => {
    const where = `${job.ws.wp.id}${step ? `.${step.id}` : ''} (job ${job.idx})`;
    throw new SimError(`${where}: ${(e as Error).message}`);
  };
  const evalIn = (job: Job, step: CStep | null, c: CExpr) => {
    try {
      return withRng(job.ws.rng, 'sample', () => evalExpr(c, job.scope));
    } catch (e) {
      return fail(job, step, e);
    }
  };
  const triggerTime = (ws: WpState, c: CExpr, k: number): number => {
    try {
      const v = withRng(ws.trigRng, 'sample', () => evalExpr(c, { ...cm.params, job: k }));
      return Math.max(0, Math.round(toBase(v, 'time') * PS_PER_S));
    } catch (e) {
      throw new SimError(`${ws.wp.id}.trigger: ${(e as Error).message}`);
    }
  };

  // ---- job lifecycle --------------------------------------------------------

  const activate = (ws: WpState, activation: number, origin: number, jitterPs: number) => {
    for (let r = 0; r < ws.wp.trigger.repeat; r++) {
      ws.activations++;
      if (jitterPs > 0) q.schedule(q.now + jitterPs, () => admit(ws, activation, origin));
      else admit(ws, activation, origin);
    }
  };

  const admit = (ws: WpState, activation: number, origin: number) => {
    if (ws.inFlight >= ws.wp.maxInFlight) {
      if (ws.wp.onOverrun === 'skip') ws.skipped++;
      else ws.waiting.push({ activation, origin });
      return;
    }
    startJob(ws, activation, origin);
  };

  const startJob = (ws: WpState, activation: number, origin: number) => {
    const wp = ws.wp;
    ws.inFlight++;
    const idx = ws.jobs.length;
    const record: JobRecord = {
      idx,
      activation,
      release: q.now,
      completion: -1,
      origin,
      missed: false,
      e2eMissed: false,
    };
    ws.jobs.push(record);
    const job: Job = {
      ws,
      idx,
      activation,
      release: q.now,
      origin,
      absDeadline: wp.deadlinePs === null ? Infinity : activation + wp.deadlinePs,
      scope: { ...cm.params, job: idx, t: activation / PS_PER_S, in_bytes: 0 },
      steps: [],
      left: wp.steps.length,
      record,
    };
    for (const v of wp.vars) job.scope[v.name] = evalIn(job, null, v.expr);
    job.steps = wp.steps.map((def) => ({
      def,
      job,
      pending: def.preds.length,
      readyT: -1,
      startT: -1,
      streamT: -1,
      endT: -1,
      bytes: 0,
      alloc: 0,
      consumersLeft: def.succs.length,
      critPred: -1,
      task: null,
    }));
    if (wp.steps.length === 0) return jobDone(job);
    for (const r of wp.roots) stepReady(job.steps[r]);
  };

  const stepReady = (si: StepInst) => {
    const { def, job } = si;
    si.readyT = q.now;
    if (def.kind === 'compute') {
      let inBytes = 0;
      for (const p of def.preds) if (job.steps[p].def.kind === 'transfer') inBytes += job.steps[p].bytes;
      job.scope.in_bytes = inBytes;
      let workPs: number;
      try {
        const w = toWork(evalIn(job, def, def.cycles));
        const proc = cm.processors[def.proc];
        workPs = 'cycles' in w ? (w.cycles / proc.freqHz) * PS_PER_S : w.seconds * PS_PER_S;
      } catch (e) {
        return fail(job, def, e);
      }
      if (workPs < 0) fail(job, def, new Error(`negative work (${workPs} ps)`));
      const procIdx = def.proc;
      const task: Task = {
        remaining: Math.ceil(workPs - 1e-6),
        prio: def.priority,
        deadline: def.deadlinePs !== null ? job.activation + def.deadlinePs : job.absDeadline,
        readyT: q.now,
        seq: seq++,
        startT: -1,
        execPs: 0,
        preemptions: 0,
        core: -1,
        segStart: 0,
        workStart: 0,
        ev: null,
        onDone: () => {
          si.startT = task.startT;
          stepDone(si);
        },
        onSegment: (_t, core, s0, s1) => {
          if (s1 > s0 && canTrace()) trace.compute.push(procIdx, core, s0, s1, job.ws.wp.idx, job.idx, def.idx);
        },
      };
      si.task = task;
      procs[procIdx].submit(task);
    } else if (def.kind === 'transfer') {
      let bytes: number;
      try {
        bytes = toBase(evalIn(job, def, def.bytes), 'bytes');
      } catch (e) {
        return fail(job, def, e);
      }
      if (bytes < 0) fail(job, def, new Error(`negative size (${bytes} B)`));
      si.bytes = bytes;
      const path = def.path;
      const finish = () => {
        if (path.dma >= 0) dmas[path.dma].release();
        stepDone(si);
      };
      const begin = () => {
        si.startT = q.now;
        if (path.dstMem >= 0 && bytes > 0) {
          si.alloc = bytes;
          allocate(path.dstMem, bytes);
        }
        q.after(path.latencyPs, () => {
          si.streamT = q.now;
          if (bytes === 0 || !Number.isFinite(path.idealBps)) return finish();
          fabric.add({
            usage: path.usage,
            weight: def.weight,
            prio: def.priority,
            cap: path.capBps / PS_PER_S,
            remaining: bytes,
            total: bytes,
            rate: 0,
            onDone: finish,
          });
        });
      };
      if (path.dma >= 0) dmas[path.dma].acquire({ prio: def.priority, readyT: q.now, seq: seq++, grant: begin });
      else begin();
    } else {
      let dur: number;
      try {
        dur = Math.round(toBase(evalIn(job, def, def.time), 'time') * PS_PER_S);
      } catch (e) {
        return fail(job, def, e);
      }
      if (dur < 0) fail(job, def, new Error('negative delay'));
      si.startT = q.now;
      q.after(dur, () => stepDone(si));
    }
  };

  const release = (si: StepInst) => {
    if (si.alloc > 0) {
      allocate(si.def.kind === 'transfer' ? si.def.path.dstMem : -1, -si.alloc);
      si.alloc = 0;
    }
  };

  const stepDone = (si: StepInst) => {
    const { def, job } = si;
    const ws = job.ws;
    si.endT = q.now;
    const agg = ws.steps[def.idx];
    agg.wait.push(si.startT - si.readyT);
    agg.service.push(si.endT - si.startT);
    if (def.kind === 'transfer') {
      agg.bytes += si.bytes;
      if (canTrace())
        trace.transfers.push(ws.wp.idx, job.idx, def.idx, si.readyT, si.startT, si.streamT, si.endT, si.bytes);
    } else if (def.kind === 'delay' && canTrace()) {
      trace.delays.push(ws.wp.idx, job.idx, def.idx, si.startT, si.endT);
    }
    if (def.deadlinePs !== null && si.endT - job.activation > def.deadlinePs) agg.misses++;

    // Data written by a predecessor transfer is dead once all its consumers are done.
    for (const p of def.preds) {
      const ps = job.steps[p];
      if (--ps.consumersLeft === 0) release(ps);
    }
    notify(ws.wp.idx, def.idx, job.origin);

    for (const s of def.succs) {
      const succ = job.steps[s];
      if (--succ.pending === 0) {
        succ.critPred = def.idx;
        stepReady(succ);
      }
    }
    if (--job.left === 0) jobDone(job);
  };

  const jobDone = (job: Job) => {
    const ws = job.ws;
    const wp = ws.wp;
    const now = q.now;
    for (const si of job.steps) release(si); // outputs with no in-job consumer live until job end
    const rec = job.record;
    rec.completion = now;
    rec.missed = wp.deadlinePs !== null && now - job.activation > wp.deadlinePs;
    rec.e2eMissed = wp.e2eDeadlinePs !== null && now - job.origin > wp.e2eDeadlinePs;

    // Critical path: walk back from the last step to finish through the predecessor
    // that finished last (the one that made each step ready).
    if (job.steps.length) {
      let last = job.steps[0];
      for (const si of job.steps) if (si.endT >= last.endT) last = si;
      const path: PathStep[] = [];
      for (let cur: StepInst | null = last; cur; cur = cur.critPred >= 0 ? job.steps[cur.critPred] : null) {
        path.unshift(describe(cur));
      }
      const total = new Map<string, number>();
      const add = (k: string, v: number) => {
        if (v > 0) total.set(k, (total.get(k) ?? 0) + v);
      };
      add('Release delay', job.release - job.activation);
      for (const p of path) for (const [k, v] of Object.entries(p.parts)) add(k, v);
      for (const [k, v] of total) ws.breakdown.set(k, (ws.breakdown.get(k) ?? 0) + v);
      const response = now - job.activation;
      if (!ws.worst || response > ws.worst.response) {
        if (job.release > job.activation)
          path.unshift({
          step: '(release)',
          kind: 'delay',
          resource: '',
          readyT: job.activation,
          startT: job.activation,
          endT: job.release,
            parts: { 'Release delay': job.release - job.activation },
          });
        ws.worst = { job: job.idx, response, path };
      }
    }

    ws.inFlight--;
    notify(wp.idx, -1, job.origin);
    if (ws.waiting.length && ws.inFlight < wp.maxInFlight) {
      const next = ws.waiting.shift()!;
      startJob(ws, next.activation, next.origin);
    }
  };

  const describe = (si: StepInst): PathStep => {
    const def = si.def;
    const parts: Record<string, number> = {};
    let resource = '';
    if (def.kind === 'compute') {
      const name = cm.processors[def.proc].id;
      resource = name;
      const exec = si.task?.execPs ?? 0;
      parts[`Queue @${name}`] = si.startT - si.readyT;
      parts[`Exec @${name}`] = exec;
      parts[`Preempted @${name}`] = si.endT - si.startT - exec;
    } else if (def.kind === 'transfer') {
      const path = def.path;
      resource = [...path.readHops, ...path.writeHops].join('→') || path.initiator;
      if (path.dma >= 0) parts[`DMA wait @${cm.dmas[path.dma].id}`] = si.startT - si.readyT;
      parts['Latency'] = si.streamT - si.startT;
      const stream = si.endT - si.streamT;
      const ideal = Number.isFinite(path.idealBps) ? (si.bytes / path.idealBps) * PS_PER_S : 0;
      const contention = Math.max(0, stream - ideal);
      parts['Transfer'] = stream - contention;
      parts['Contention'] = contention;
    } else {
      parts['Delay'] = si.endT - si.startT;
    }
    for (const k of Object.keys(parts)) if (parts[k] <= 0) delete parts[k];
    return { step: def.id, kind: def.kind, resource, readyT: si.readyT, startT: si.startT, endT: si.endT, parts };
  };

  // ---- triggers -------------------------------------------------------------

  const notify = (wpIdx: number, stepIdx: number, origin: number) => {
    const ls = listeners.get(`${wpIdx}:${stepIdx}`);
    if (!ls) return;
    for (const { target, src } of ls) {
      const tr = target.wp.trigger;
      if (tr.type !== 'event') continue;
      const tokens = target.tokens[src];
      tokens.push(origin);
      // 'latest' keeps only as many tokens as one firing needs, dropping the oldest.
      if (tr.consume === 'latest' && tokens.length > tr.every) tokens.splice(0, tokens.length - tr.every);
      let consumed: number[] | null = null;
      if (tr.mode === 'all') {
        if (target.tokens.every((tk) => tk.length >= tr.every)) {
          consumed = target.tokens.flatMap((tk) => tk.splice(0, tr.every));
        }
      } else {
        const total = target.tokens.reduce((a, tk) => a + tk.length, 0);
        if (total >= tr.every) consumed = target.tokens.flatMap((tk) => tk.splice(0));
      }
      if (!consumed) continue;
      const org = Math.min(...consumed);
      const delay = tr.delay ? triggerTime(target, tr.delay, target.activations) : 0;
      if (delay > 0) q.after(delay, () => activate(target, q.now, org, 0));
      else activate(target, q.now, org, 0);
    }
  };

  for (const ws of states) {
    const tr = ws.wp.trigger;
    if (tr.type === 'periodic') {
      const fire = (k: number) => {
        const at = tr.offsetPs + k * tr.periodPs;
        if (k >= tr.count || at > T) return;
        q.schedule(at, () => {
          const jitter = tr.jitter ? triggerTime(ws, tr.jitter, k) : 0;
          activate(ws, q.now, q.now, jitter);
          fire(k + 1);
        });
      };
      fire(0);
    } else if (tr.type === 'poisson') {
      const fire = (k: number, from: number) => {
        if (k >= tr.count) return;
        const mean = triggerTime(ws, tr.interval, k);
        if (mean <= 0 && tr.minPs <= 0) throw new SimError(`${ws.wp.id}.trigger: mean interval must be positive`);
        // Exponential gaps make arrivals a Poisson process with the given mean interval.
        const gap = Math.max(tr.minPs, Math.round(ws.trigRng.exponential(mean)));
        const at = from + gap;
        if (at > T) return;
        q.schedule(at, () => {
          activate(ws, q.now, q.now, 0);
          fire(k + 1, q.now);
        });
      };
      fire(0, 0);
    } else if (tr.type === 'times') {
      for (const at of tr.timesPs) if (at <= T) q.schedule(at, () => activate(ws, q.now, q.now, 0));
    }
  }

  // ---- run -----------------------------------------------------------------
  let nextReport = 20_000;
  while (q.step(T)) {
    if (q.processed >= nextReport) {
      nextReport += 20_000;
      opts.onProgress?.(q.now / T);
      if (q.processed > maxEvents) {
        warnings.push(`Stopped early at ${(q.now / 1e9).toFixed(3)} ms after ${maxEvents.toLocaleString()} events`);
        break;
      }
    }
  }
  const end = q.processed > maxEvents ? q.now : T;
  q.now = end;
  fabric.finish(end);
  for (const p of procs) p.flush(end);

  // ---- results ---------------------------------------------------------------
  const workplans: WorkplanResult[] = states.map((ws) => {
    const wp = ws.wp;
    const done = ws.jobs.filter((j) => j.completion >= 0);
    let missed = 0;
    let e2eMissed = 0;
    let incomplete = ws.waiting.length;
    for (const j of ws.jobs) {
      if (j.completion < 0) {
        incomplete++;
        // Still running past its deadline counts as a miss already.
        if (wp.deadlinePs !== null && end - j.activation > wp.deadlinePs) j.missed = true;
      }
      if (j.missed) missed++;
      if (j.e2eMissed) e2eMissed++;
    }
    for (const w of ws.waiting) if (wp.deadlinePs !== null && end - w.activation > wp.deadlinePs) missed++;
    const breakdown: Record<string, number> = {};
    for (const [k, v] of ws.breakdown) breakdown[k] = v / Math.max(1, done.length);
    const steps: StepStat[] = wp.steps.map((s, i) => {
      const agg = ws.steps[i];
      let resource = '';
      if (s.kind === 'compute') resource = cm.processors[s.proc].id;
      else if (s.kind === 'transfer') resource = `${s.path.initiator}: ${[...s.path.readHops, ...s.path.writeHops].join('→') || 'direct'}`;
      return {
        id: s.id,
        kind: s.kind,
        resource,
        count: agg.service.length,
        wait: summarize(agg.wait),
        service: summarize(agg.service),
        meanBytes: agg.service.length ? agg.bytes / agg.service.length : 0,
        deadlineMisses: agg.misses,
      };
    });
    if (incomplete > 0 && wp.maxInFlight === Infinity && incomplete > 2) {
      warnings.push(`${wp.id}: ${incomplete} jobs unfinished at the end — the system may be overloaded`);
    }
    return {
      id: wp.id,
      name: wp.name,
      deadlinePs: wp.deadlinePs,
      e2eDeadlinePs: wp.e2eDeadlinePs,
      activations: ws.activations,
      released: ws.jobs.length,
      completed: done.length,
      skipped: ws.skipped,
      missed,
      e2eMissed,
      incomplete,
      response: summarize(done.map((j) => j.completion - j.activation)),
      e2e: summarize(done.map((j) => j.completion - j.origin)),
      jobs: ws.jobs,
      steps,
      breakdown,
      worst: ws.worst,
    };
  });

  const W = cm.utilWindowPs;
  const pack = (s: StepSeries) => ({ t: statsOnly ? [] : s.t, v: statsOnly ? [] : s.v, truncated: s.truncated });
  const peak = (s: StepSeries) => (statsOnly || s.truncated ? s.peak(end) : peakWindowAverage(s.t, s.v, end, W));
  const resources: ResourceResult[] = [];
  procs.forEach((p) => {
    const spec = p.spec;
    resources.push({
      id: spec.id,
      name: spec.name,
      kind: 'processor',
      lane: 'cores',
      capacity: spec.cores,
      utilization: end > 0 ? p.busy.integral(end) / end : 0,
      peakWindowUtil: peak(p.busy),
      bytes: 0,
      throughput: 0,
      series: pack(p.busy),
      queue: {
        t: statsOnly ? [] : p.queue.t,
        v: statsOnly ? [] : p.queue.v,
        mean: end > 0 ? p.queue.integral(end) / end : 0,
        max: p.queue.peak(end),
      },
      extra: { dispatches: p.dispatches, preemptions: p.preemptions },
    });
  });
  cm.resources.forEach((r, i) => {
    const s = fabric.series[i];
    const owner =
      r.ownerKind === 'memory' ? cm.memories[cm.kinds.get(r.owner)!.idx].name : cm.buses[cm.kinds.get(r.owner)!.idx].name;
    resources.push({
      id: r.id,
      name: r.lane === 'rw' ? owner : `${owner} (${r.lane === 'rd' ? 'read' : 'write'})`,
      kind: r.ownerKind,
      lane: r.lane,
      capacity: r.capBps,
      utilization: end > 0 ? fabric.bytes[i] / ((r.capBps / PS_PER_S) * end) : 0,
      peakWindowUtil: peak(s),
      bytes: fabric.bytes[i],
      throughput: end > 0 ? fabric.bytes[i] / (end / PS_PER_S) : 0,
      series: pack(s),
    });
  });
  dmas.forEach((d) => {
    resources.push({
      id: d.spec.id,
      name: d.spec.name,
      kind: 'dma',
      lane: 'channels',
      capacity: d.spec.channels,
      utilization: end > 0 ? d.busy.integral(end) / end : 0,
      peakWindowUtil: peak(d.busy),
      bytes: 0,
      throughput: 0,
      series: pack(d.busy),
      queue: {
        t: statsOnly ? [] : d.queue.t,
        v: statsOnly ? [] : d.queue.v,
        mean: end > 0 ? d.queue.integral(end) / end : 0,
        max: d.queue.peak(end),
      },
    });
  });

  const footprints: FootprintResult[] = cm.memories.map((m, i) => {
    const s = footprint[i];
    const peakBytes = s.peak(end);
    if (peakBytes > m.sizeBytes) {
      warnings.push(`${m.id}: peak buffer footprint ${fmtBytes(peakBytes)} exceeds its ${fmtBytes(m.sizeBytes)} capacity`);
    }
    return {
      id: m.id,
      name: m.name,
      size: m.sizeBytes,
      peak: peakBytes,
      mean: end > 0 ? s.integral(end) / end : 0,
      series: { t: statsOnly ? [] : s.t, v: statsOnly ? [] : s.v },
    };
  });

  for (const r of resources) {
    if (r.series.truncated) warnings.push(`${r.id}: utilization trace truncated; peak shown is the instantaneous maximum`);
  }
  if (trace.truncated) warnings.push(`Timeline limited to the first ${traceLimit.toLocaleString()} segments (sim.traceLimit)`);

  return {
    ok: true,
    durationPs: end,
    events: q.processed,
    wallMs: performance.now() - t0,
    utilWindowPs: W,
    workplans,
    resources,
    footprints,
    trace,
    warnings,
    names: {
      procs: cm.processors.map((p) => p.id),
      procCores: cm.processors.map((p) => p.cores),
      wps: cm.workplans.map((w) => w.id),
      steps: cm.workplans.map((w) => w.steps.map((s) => s.id)),
      stepKinds: cm.workplans.map((w) => w.steps.map((s) => s.kind)),
      transferRes: cm.workplans.map((w) =>
        w.steps.map((s) => (s.kind === 'transfer' ? s.path.usage.map((u) => cm.resources[u.res].id) : [])),
      ),
      transferDma: cm.workplans.map((w) => w.steps.map((s) => (s.kind === 'transfer' && s.path.dma >= 0 ? cm.dmas[s.path.dma].id : ''))),
      dmas: cm.dmas.map((d) => d.id),
      dmaChannels: cm.dmas.map((d) => d.channels),
      deadlines: cm.workplans.map((w) => w.deadlinePs),
    },
  };
}

function fmtBytes(b: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let i = 0;
  while (b >= 1024 && i < units.length - 1) {
    b /= 1024;
    i++;
  }
  return `${b.toFixed(b < 10 && i > 0 ? 2 : 0)} ${units[i]}`;
}
