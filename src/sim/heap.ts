/** Binary min-heap ordered by a strict "a comes before b" predicate. */
export class Heap<T> {
  private items: T[] = [];
  constructor(private readonly before: (a: T, b: T) => boolean) {}

  get size(): number {
    return this.items.length;
  }

  peek(): T | undefined {
    return this.items[0];
  }

  push(item: T): void {
    const a = this.items;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.before(a[i], a[p])) break;
      [a[i], a[p]] = [a[p], a[i]];
      i = p;
    }
  }

  pop(): T | undefined {
    const a = this.items;
    if (a.length === 0) return undefined;
    const top = a[0];
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && this.before(a[l], a[m])) m = l;
        if (r < a.length && this.before(a[r], a[m])) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }
}

export interface SimEvent {
  t: number;
  seq: number;
  fn: () => void;
  cancelled: boolean;
}

/**
 * The future-event list. Events at equal times run in scheduling order (by sequence
 * number), which makes every run bit-for-bit reproducible.
 */
export class EventQueue {
  now = 0;
  processed = 0;
  private seq = 0;
  private heap = new Heap<SimEvent>((a, b) => a.t < b.t || (a.t === b.t && a.seq < b.seq));

  schedule(t: number, fn: () => void): SimEvent {
    if (t < this.now) throw new Error(`event scheduled in the past (${t} < ${this.now})`);
    const ev = { t, seq: this.seq++, fn, cancelled: false };
    this.heap.push(ev);
    return ev;
  }

  after(dt: number, fn: () => void): SimEvent {
    return this.schedule(this.now + dt, fn);
  }

  get pending(): number {
    return this.heap.size;
  }

  peekTime(): number {
    return this.heap.peek()?.t ?? Infinity;
  }

  /** Runs the next live event; returns false once nothing is left before `until`. */
  step(until: number): boolean {
    for (;;) {
      const ev = this.heap.peek();
      if (!ev || ev.t > until) return false;
      this.heap.pop();
      if (ev.cancelled) continue;
      this.now = ev.t;
      this.processed++;
      ev.fn();
      return true;
    }
  }
}
