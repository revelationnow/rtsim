import type { EventQueue, SimEvent } from './heap';
import { StepSeries } from './series';

/**
 * A transfer streaming through the interconnect. Rates are in bytes per picosecond.
 */
export interface Flow {
  usage: { res: number; coef: number }[];
  weight: number;
  prio: number;
  /** Per-flow rate ceiling (outstanding-transaction limit), bytes/ps. */
  cap: number;
  remaining: number;
  total: number;
  rate: number;
  /**
   * Called when the flow's bytes are done. Returning a positive byte count refills the flow in
   * place (a stream of packets), which keeps the allocation unchanged and avoids re-solving it.
   */
  onDone: () => number | void;
}

/**
 * Fluid (flow-level) model of buses and memories. Every active transfer gets a rate from a
 * weighted max-min fair allocation over the resources it crosses, served in strict priority
 * classes, and bounded by its own cap. Rates are recomputed only when a transfer starts or
 * finishes, so a multi-megabyte DMA costs two events instead of one per burst, while shared
 * links still split bandwidth exactly as a fair or QoS arbiter would on average.
 */
export class Fabric {
  private flows: Flow[] = [];
  private lastT = 0;
  private next: SimEvent | null = null;
  private deferDepth = 0;
  private membershipChanged = false;
  /** Bytes/ps currently consumed on each resource. */
  private readonly load: Float64Array;
  readonly series: StepSeries[];
  /** Bytes carried by each resource (sum of coef x bytes moved). */
  readonly bytes: Float64Array;

  constructor(
    private readonly q: EventQueue,
    /** Capacity of each resource in bytes/ps. */
    private readonly caps: number[],
    private readonly ignorePriority: boolean,
    seriesLimit: number,
  ) {
    this.load = new Float64Array(caps.length);
    this.bytes = new Float64Array(caps.length);
    this.series = caps.map(() => new StepSeries(seriesLimit));
  }

  get active(): number {
    return this.flows.length;
  }

  add(flow: Flow): void {
    this.advance(this.q.now);
    this.flows.push(flow);
    this.changed();
  }

  /** Brings every flow's remaining byte count up to `now`. */
  advance(now: number): void {
    const dt = now - this.lastT;
    if (dt <= 0) return;
    for (const f of this.flows) f.remaining -= f.rate * dt;
    for (let r = 0; r < this.load.length; r++) this.bytes[r] += this.load[r] * dt;
    this.lastT = now;
  }

  private changed(): void {
    this.membershipChanged = true;
    if (this.deferDepth > 0) return;
    this.reallocate();
    this.scheduleNext();
  }

  /** Weighted max-min fair allocation by progressive filling, one priority class at a time. */
  private reallocate(): void {
    const n = this.caps.length;
    const left = Float64Array.from(this.caps);
    for (const f of this.flows) f.rate = 0;

    const classes = new Map<number, Flow[]>();
    for (const f of this.flows) {
      const p = this.ignorePriority ? 0 : f.prio;
      let c = classes.get(p);
      if (!c) classes.set(p, (c = []));
      c.push(f);
    }
    const order = [...classes.keys()].sort((a, b) => b - a);
    const demand = new Float64Array(n);
    const saturated = new Uint8Array(n);
    for (let r = 0; r < n; r++) if (left[r] <= 0) saturated[r] = 1;

    for (const p of order) {
      let open = classes.get(p)!.filter((f) => f.weight > 0 && !f.usage.some((u) => saturated[u.res]));
      while (open.length) {
        demand.fill(0);
        for (const f of open) for (const u of f.usage) demand[u.res] += u.coef * f.weight;
        let lambda = Infinity;
        for (let r = 0; r < n; r++) if (demand[r] > 0) lambda = Math.min(lambda, left[r] / demand[r]);
        for (const f of open) lambda = Math.min(lambda, (f.cap - f.rate) / f.weight);
        if (!Number.isFinite(lambda)) break; // flows that touch nothing and have no cap: handled by the caller
        for (const f of open) f.rate += lambda * f.weight;
        for (let r = 0; r < n; r++) {
          if (demand[r] > 0) {
            left[r] -= lambda * demand[r];
            if (left[r] <= this.caps[r] * 1e-12) {
              left[r] = 0;
              saturated[r] = 1;
            }
          }
        }
        open = open.filter((f) => f.rate < f.cap * (1 - 1e-12) && !f.usage.some((u) => saturated[u.res]));
      }
    }

    const now = this.q.now;
    this.load.fill(0);
    for (const f of this.flows) for (const u of f.usage) this.load[u.res] += u.coef * f.rate;
    for (let r = 0; r < n; r++) this.series[r].set(now, Math.min(1, this.load[r] / this.caps[r]));
  }

  private scheduleNext(): void {
    if (this.next) this.next.cancelled = true;
    this.next = null;
    let dt = Infinity;
    for (const f of this.flows) if (f.rate > 0) dt = Math.min(dt, f.remaining / f.rate);
    if (!Number.isFinite(dt)) return;
    // Round up: an event may land a fraction of a picosecond late, never early.
    this.next = this.q.after(Math.max(0, Math.ceil(dt - 1e-9)), () => this.complete());
  }

  private complete(): void {
    this.next = null;
    this.advance(this.q.now);
    const done: Flow[] = [];
    for (const f of this.flows) {
      if (f.remaining <= Math.max(1e-6, f.total * 1e-12) || (f.rate > 0 && f.remaining / f.rate < 0.5)) done.push(f);
    }
    // Completions can start new transfers; batch them into one reallocation.
    const before = this.flows.length;
    this.membershipChanged = false;
    this.deferDepth++;
    const ended = new Set<Flow>();
    try {
      for (const f of done) {
        const more = f.onDone();
        if (typeof more === 'number' && more > 0) {
          f.remaining = more;
          f.total = more;
        } else ended.add(f);
      }
    } finally {
      this.deferDepth--;
    }
    if (ended.size) this.flows = this.flows.filter((f) => !ended.has(f));
    if (ended.size || this.membershipChanged || this.flows.length !== before) this.reallocate();
    this.scheduleNext();
  }

  /** Closes the books at the end of the run. */
  finish(end: number): void {
    this.advance(end);
  }
}
