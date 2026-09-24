/**
 * A piecewise-constant signal: value v[i] holds from t[i] until t[i+1]. Used for
 * utilization, queue depth and buffer footprint. The integral is tracked exactly even
 * when the point budget runs out, so averages never depend on the recording limit.
 */
export class StepSeries {
  readonly t: number[] = [0];
  readonly v: number[] = [0];
  truncated = false;
  private lastT = 0;
  private lastV = 0;
  private area = 0;
  private held = 0;

  constructor(private readonly limit = 100_000) {}

  set(t: number, v: number): void {
    if (v === this.lastV) return;
    // Only values held for a non-zero time count toward the peak, so an allocate-and-free
    // in the same instant does not register as a spike.
    if (t > this.lastT && this.lastV > this.held) this.held = this.lastV;
    this.area += this.lastV * (t - this.lastT);
    this.lastT = t;
    this.lastV = v;
    const n = this.t.length;
    if (this.t[n - 1] === t) {
      this.v[n - 1] = v;
      // Collapse a point that returned to the previous level within the same instant.
      if (n > 1 && this.v[n - 2] === v) {
        this.t.pop();
        this.v.pop();
      }
    } else if (n < this.limit) {
      this.t.push(t);
      this.v.push(v);
    } else {
      this.truncated = true;
    }
  }

  get current(): number {
    return this.lastV;
  }

  /** Largest value held for a non-zero duration within [0, end]. */
  peak(end: number): number {
    return end > this.lastT ? Math.max(this.held, this.lastV) : this.held;
  }

  /** Integral of the signal over [0, end]. */
  integral(end: number): number {
    return this.area + this.lastV * (end - this.lastT);
  }
}

/**
 * Largest average of a piecewise-constant signal over any window of length w in [0, end].
 * g(s) = F(s + w) − F(s) is piecewise linear in s with breakpoints where s or s + w hits a
 * change point, so checking those candidates finds the exact maximum.
 */
export function peakWindowAverage(t: number[], v: number[], end: number, w: number): number {
  if (end <= 0) return 0;
  if (w >= end) {
    let area = 0;
    for (let i = 0; i < t.length; i++) area += v[i] * (Math.min(end, t[i + 1] ?? end) - t[i]);
    return area / end;
  }
  const n = t.length;
  const cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) cum[i + 1] = cum[i] + v[i] * ((i + 1 < n ? t[i + 1] : end) - t[i]);
  const F = (x: number) => {
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (t[mid] <= x) lo = mid;
      else hi = mid - 1;
    }
    return cum[lo] + v[lo] * (x - t[lo]);
  };
  let best = 0;
  const consider = (s: number) => {
    if (s < 0 || s > end - w) return;
    const g = F(s + w) - F(s);
    if (g > best) best = g;
  };
  consider(0);
  consider(end - w);
  for (let i = 0; i < n; i++) {
    consider(t[i]);
    consider(t[i] - w);
  }
  return best / w;
}
