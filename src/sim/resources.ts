import type { CDma, CProcessor } from '../model/compile';
import { Heap, type EventQueue, type SimEvent } from './heap';
import { StepSeries } from './series';

/** A unit of compute waiting for or running on a processor. */
export interface Task {
  /** Remaining work in picoseconds of execution. */
  remaining: number;
  prio: number;
  /** Absolute deadline for EDF (Infinity when none). */
  deadline: number;
  readyT: number;
  seq: number;
  startT: number;
  execPs: number;
  preemptions: number;
  core: number;
  segStart: number;
  workStart: number;
  ev: SimEvent | null;
  onDone: (t: Task) => void;
  onSegment: (t: Task, core: number, t0: number, t1: number) => void;
}

/**
 * A multi-core processor or hardware block with a single global ready queue.
 * FIFO dispatches in ready order; fixed-priority picks the highest priority; EDF the
 * earliest absolute deadline. With preemption on, a newly ready task displaces the
 * worst running one when it is strictly better. Each dispatch pays the context-switch cost.
 */
export class ProcessorSim {
  private readonly cores: (Task | null)[];
  private readonly ready: Heap<Task>;
  readonly busy: StepSeries;
  readonly queue: StepSeries;
  private busyCount = 0;
  dispatches = 0;
  preemptions = 0;

  constructor(
    readonly spec: CProcessor,
    private readonly q: EventQueue,
    seriesLimit: number,
  ) {
    this.cores = new Array(spec.cores).fill(null);
    this.ready = new Heap((a, b) => this.better(a, b));
    this.busy = new StepSeries(seriesLimit);
    this.queue = new StepSeries(seriesLimit);
  }

  /** Strict total order: is `a` preferred over `b`? */
  private better(a: Task, b: Task): boolean {
    switch (this.spec.policy) {
      case 'fixed-priority':
        if (a.prio !== b.prio) return a.prio > b.prio;
        break;
      case 'edf':
        if (a.deadline !== b.deadline) return a.deadline < b.deadline;
        break;
    }
    if (a.readyT !== b.readyT) return a.readyT < b.readyT;
    return a.seq < b.seq;
  }

  submit(task: Task): void {
    task.readyT = this.q.now;
    task.startT = -1;
    this.ready.push(task);
    this.dispatch();
  }

  private dispatch(): void {
    for (;;) {
      const head = this.ready.peek();
      if (!head) break;
      const idle = this.cores.indexOf(null);
      if (idle >= 0) {
        this.start(this.ready.pop()!, idle);
        continue;
      }
      if (!this.spec.preemptive) break;
      let worst = -1;
      for (let c = 0; c < this.cores.length; c++) {
        if (worst < 0 || this.better(this.cores[worst]!, this.cores[c]!)) worst = c;
      }
      if (!this.better(head, this.cores[worst]!)) break;
      this.preempt(worst);
      this.start(this.ready.pop()!, worst);
    }
    this.queue.set(this.q.now, this.ready.size);
  }

  private start(task: Task, core: number): void {
    const now = this.q.now;
    this.cores[core] = task;
    this.busyCount++;
    this.busy.set(now, this.busyCount / this.cores.length);
    this.dispatches++;
    if (task.startT < 0) task.startT = now;
    task.core = core;
    task.segStart = now;
    task.workStart = now + this.spec.ctxPs;
    task.ev = this.q.schedule(task.workStart + task.remaining, () => this.finish(task));
  }

  private stop(task: Task): void {
    const now = this.q.now;
    this.cores[task.core] = null;
    this.busyCount--;
    this.busy.set(now, this.busyCount / this.cores.length);
    task.execPs += now - task.segStart;
    task.onSegment(task, task.core, task.segStart, now);
  }

  private preempt(core: number): void {
    const task = this.cores[core]!;
    const now = this.q.now;
    task.ev!.cancelled = true;
    task.ev = null;
    // Work only progresses once the context switch has completed.
    task.remaining -= Math.max(0, now - task.workStart);
    task.preemptions++;
    this.preemptions++;
    this.stop(task);
    this.ready.push(task);
  }

  private finish(task: Task): void {
    task.ev = null;
    task.remaining = 0;
    this.stop(task);
    task.onDone(task);
    this.dispatch();
  }

  /** Emits segments for tasks still running at the end of the run. */
  flush(end: number): void {
    for (const t of this.cores) if (t) t.onSegment(t, t.core, t.segStart, end);
  }
}

export interface DmaRequest {
  prio: number;
  readyT: number;
  seq: number;
  grant: () => void;
}

/** A DMA engine's channel pool: requests beyond `channels` wait in FIFO or priority order. */
export class DmaSim {
  private free: number;
  private readonly waiting: Heap<DmaRequest>;
  readonly busy: StepSeries;
  readonly queue: StepSeries;

  constructor(
    readonly spec: CDma,
    private readonly q: EventQueue,
    seriesLimit: number,
  ) {
    this.free = spec.channels;
    this.waiting = new Heap((a, b) => {
      if (spec.policy === 'priority' && a.prio !== b.prio) return a.prio > b.prio;
      if (a.readyT !== b.readyT) return a.readyT < b.readyT;
      return a.seq < b.seq;
    });
    this.busy = new StepSeries(seriesLimit);
    this.queue = new StepSeries(seriesLimit);
  }

  acquire(req: DmaRequest): void {
    req.readyT = this.q.now;
    if (this.free > 0) {
      this.free--;
      this.mark();
      req.grant();
    } else {
      this.waiting.push(req);
      this.mark();
    }
  }

  release(): void {
    const next = this.waiting.pop();
    if (next) {
      this.mark();
      next.grant();
    } else {
      this.free++;
      this.mark();
    }
  }

  private mark(): void {
    this.busy.set(this.q.now, (this.spec.channels - this.free) / this.spec.channels);
    this.queue.set(this.q.now, this.waiting.size);
  }
}
