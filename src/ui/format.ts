/** Human formatting for engineering quantities. Times arrive in picoseconds. */

const sig = (v: number, digits = 3) => {
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a >= 1000) return Math.round(v).toLocaleString('en-US');
  return String(+v.toPrecision(digits));
};

export function fmtTime(ps: number | null | undefined, digits = 3): string {
  if (ps === null || ps === undefined || !Number.isFinite(ps)) return '—';
  const a = Math.abs(ps);
  if (a === 0) return '0';
  if (a >= 1e12) return `${sig(ps / 1e12, digits)} s`;
  if (a >= 1e9) return `${sig(ps / 1e9, digits)} ms`;
  if (a >= 1e6) return `${sig(ps / 1e6, digits)} µs`;
  if (a >= 1e3) return `${sig(ps / 1e3, digits)} ns`;
  return `${sig(ps, digits)} ps`;
}

export function fmtSeconds(s: number, digits = 3): string {
  return fmtTime(s * 1e12, digits);
}

export function fmtBytes(b: number | null | undefined, digits = 3): string {
  if (b === null || b === undefined || !Number.isFinite(b)) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0;
  let v = b;
  while (Math.abs(v) >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${sig(v, digits)} ${units[i]}`;
}

export function fmtRate(bps: number | null | undefined, digits = 3): string {
  if (bps === null || bps === undefined || !Number.isFinite(bps)) return '—';
  const units = ['B/s', 'kB/s', 'MB/s', 'GB/s', 'TB/s'];
  let i = 0;
  let v = bps;
  while (Math.abs(v) >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${sig(v, digits)} ${units[i]}`;
}

export function fmtHz(hz: number | null | undefined, digits = 3): string {
  if (hz === null || hz === undefined || !Number.isFinite(hz)) return '—';
  const units = ['Hz', 'kHz', 'MHz', 'GHz'];
  let i = 0;
  let v = hz;
  while (Math.abs(v) >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${sig(v, digits)} ${units[i]}`;
}

export function fmtPct(f: number | null | undefined, digits = 1): string {
  if (f === null || f === undefined || !Number.isFinite(f)) return '—';
  return `${(f * 100).toFixed(digits)}%`;
}

export function fmtNum(v: number | null | undefined, digits = 3): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return sig(v, digits);
}

/** Chooses a "nice" tick step for an axis spanning `span` with about `target` ticks. */
export function niceStep(span: number, target = 5): number {
  if (span <= 0 || !Number.isFinite(span)) return 1;
  const raw = span / target;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / pow;
  const m = n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10;
  return m * pow;
}

export function ticks(min: number, max: number, target = 5): number[] {
  const step = niceStep(max - min, target);
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(+v.toPrecision(12));
  return out;
}
