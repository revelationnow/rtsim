import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ticks } from './format';

export function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(600);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(120, Math.floor(e.contentRect.width))));
    ro.observe(el);
    setW(Math.max(120, Math.floor(el.getBoundingClientRect().width)));
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

const M = { l: 56, r: 16, t: 10, b: 30 };

/** Formatters take an optional significant-digit count so axes can add precision on demand. */
export type Fmt = (v: number, digits?: number) => string;

/** Labels for a set of ticks with just enough digits that neighbours never read the same. */
function tickLabels(vals: number[], f: Fmt): string[] {
  for (let d = 3; d <= 7; d++) {
    const labels = vals.map((v) => f(v, d));
    if (new Set(labels).size === labels.length) return labels;
  }
  return vals.map((v) => f(v, 8));
}

function Tooltip({ x, y, width, children }: { x: number; y: number; width: number; children: ReactNode }) {
  const left = x > width - 200 ? x - 12 : x + 12;
  return (
    <div
      className="pointer-events-none absolute z-20 whitespace-nowrap rounded-md border border-line bg-surface px-2 py-1.5 text-[11.5px] shadow-md"
      style={{ left, top: Math.max(0, y - 10), transform: x > width - 200 ? 'translateX(-100%)' : undefined }}
    >
      {children}
    </div>
  );
}

function Axes({
  w,
  h,
  xt,
  yt,
  sx,
  sy,
  fx,
  fy,
  xLabel,
}: {
  w: number;
  h: number;
  xt: number[];
  yt: number[];
  sx: (v: number) => number;
  sy: (v: number) => number;
  fx: Fmt;
  fy: Fmt;
  xLabel?: string;
}) {
  const xl = tickLabels(xt, fx);
  const yl = tickLabels(yt, fy);
  return (
    <g fontSize={11} fill="var(--muted)">
      {yt.map((v, i) => (
        <g key={`y${v}`}>
          <line x1={M.l} x2={w - M.r} y1={sy(v)} y2={sy(v)} stroke="var(--grid)" />
          <text x={M.l - 6} y={sy(v)} textAnchor="end" dominantBaseline="middle" className="num">
            {yl[i]}
          </text>
        </g>
      ))}
      <line x1={M.l} x2={w - M.r} y1={h - M.b} y2={h - M.b} stroke="var(--axis)" />
      {xt.map((v, i) => (
        <text key={`x${v}`} x={sx(v)} y={h - M.b + 15} textAnchor="middle" className="num">
          {xl[i]}
        </text>
      ))}
      {xLabel ? (
        <text x={w - M.r} y={h - 2} textAnchor="end">
          {xLabel}
        </text>
      ) : null}
    </g>
  );
}

export interface RefLine {
  value: number;
  label: string;
  color?: string;
}

/** Histogram of a sample, with optional vertical reference lines (deadline, p99). */
export function Histogram({
  values,
  format,
  refs = [],
  height = 180,
  color = 'var(--series-1)',
  unit = 'jobs',
}: {
  values: number[];
  format: Fmt;
  refs?: RefLine[];
  height?: number;
  color?: string;
  unit?: string;
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const bins = useMemo(() => {
    if (!values.length) return null;
    let lo = Math.min(...values);
    let hi = Math.max(...values);
    // Stretch to include a reference line only when it sits reasonably close to the data.
    for (const r of refs) if (r.value > hi && r.value - lo <= 2 * (hi - lo || hi * 0.1)) hi = r.value;
    if (hi === lo) {
      lo = lo * 0.95;
      hi = hi * 1.05 || 1;
    }
    const n = Math.min(40, Math.max(8, Math.ceil(Math.sqrt(values.length))));
    const width = (hi - lo) / n;
    const counts = new Array(n).fill(0);
    for (const v of values) counts[Math.min(n - 1, Math.floor((v - lo) / width))]++;
    return { lo, hi, width, counts, max: Math.max(...counts) };
  }, [values, refs]);
  if (!bins) return <div className="py-6 text-center text-muted">No completed jobs</div>;
  const h = height;
  const offScale = refs.some((r) => r.value > bins.hi * 1.0001);
  const top = offScale ? 26 : M.t;
  const sx = (v: number) => M.l + ((v - bins.lo) / (bins.hi - bins.lo)) * (w - M.l - M.r);
  const sy = (c: number) => h - M.b - (c / bins.max) * (h - top - M.b);
  const barW = Math.max(1, (w - M.l - M.r) / bins.counts.length - 2);
  return (
    <div ref={ref} className="relative" onMouseLeave={() => setHover(null)}>
      <svg width={w} height={h} role="img" aria-label="Histogram">
        <Axes w={w} h={h} xt={ticks(bins.lo, bins.hi, Math.max(2, Math.floor(w / 110)))} yt={ticks(0, bins.max, 4)} sx={sx} sy={sy} fx={format} fy={(v) => String(v)} />
        {bins.counts.map((c, i) => {
          const x = sx(bins.lo + i * bins.width) + 1;
          const y = sy(c);
          const bh = h - M.b - y;
          return (
            <g key={i} onMouseEnter={() => setHover(i)}>
              <rect x={x - 1} y={top} width={barW + 2} height={h - top - M.b} fill="transparent" />
              {c > 0 ? <path d={roundedTop(x, y, barW, bh, Math.min(4, barW / 2, bh))} fill={color} opacity={hover === null || hover === i ? 1 : 0.55} /> : null}
            </g>
          );
        })}
        {refs.map((r, i) =>
          r.value <= bins.hi * 1.0001 ? (
            <g key={r.label}>
              <line x1={sx(r.value)} x2={sx(r.value)} y1={M.t} y2={h - M.b} stroke={r.color ?? 'var(--critical)'} strokeWidth={2} />
              <text x={sx(r.value) - 4} y={M.t + 10 + i * 13} textAnchor="end" fontSize={11} fill="var(--ink-2)">
                {r.label}
              </text>
            </g>
          ) : (
            <text key={r.label} x={w - M.r} y={11} textAnchor="end" fontSize={11} fill="var(--ink-2)">
              {r.label} at {format(r.value)} →
            </text>
          ),
        )}
      </svg>
      {hover !== null ? (
        <Tooltip x={sx(bins.lo + (hover + 0.5) * bins.width)} y={sy(bins.counts[hover])} width={w}>
          <div className="font-semibold">
            {format(bins.lo + hover * bins.width)} – {format(bins.lo + (hover + 1) * bins.width)}
          </div>
          <div className="text-ink-2">
            {bins.counts[hover]} {unit}
          </div>
        </Tooltip>
      ) : null}
    </div>
  );
}

function roundedTop(x: number, y: number, w: number, h: number, r: number): string {
  if (h <= 0) return '';
  r = Math.max(0, Math.min(r, h));
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

export interface Series {
  name: string;
  color: string;
  points: [number, number][];
  /** Draw points only (no line). */
  dots?: boolean;
  /** Per-point colors for dots (e.g. deadline misses). */
  pointColors?: string[];
}

/** Line / scatter chart on one y-axis with a crosshair tooltip. */
export function LineChart({
  series,
  fx,
  fy,
  height = 200,
  refs = [],
  yMin,
  yMax,
  xLabel,
  step = false,
}: {
  series: Series[];
  fx: Fmt;
  fy: Fmt;
  height?: number;
  refs?: RefLine[];
  yMin?: number;
  yMax?: number;
  xLabel?: string;
  step?: boolean;
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hx, setHx] = useState<number | null>(null);
  const all = series.flatMap((s) => s.points);
  if (!all.length) return <div className="py-6 text-center text-muted">No data</div>;
  const xs = all.map((p) => p[0]);
  const ys = all.map((p) => p[1]);
  let x0 = Math.min(...xs);
  let x1 = Math.max(...xs);
  if (x0 === x1) {
    x0 -= 1;
    x1 += 1;
  }
  let y0 = yMin ?? Math.min(0, ...ys);
  let y1 = yMax ?? Math.max(...ys, ...refs.map((r) => r.value)) * 1.08;
  if (y0 === y1) y1 = y0 + 1;
  const h = height;
  const sx = (v: number) => M.l + ((v - x0) / (x1 - x0)) * (w - M.l - M.r);
  const sy = (v: number) => h - M.b - ((v - y0) / (y1 - y0)) * (h - M.t - M.b);
  const yt = ticks(y0, y1, 4);
  y1 = Math.max(y1, yt[yt.length - 1] ?? y1);
  y0 = Math.min(y0, yt[0] ?? y0);

  const path = (pts: [number, number][]) => {
    if (!step) return pts.map((p, i) => `${i ? 'L' : 'M'}${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`).join('');
    let d = '';
    pts.forEach((p, i) => {
      if (i === 0) d += `M${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`;
      else d += `H${sx(p[0]).toFixed(1)}V${sy(p[1]).toFixed(1)}`;
    });
    return d;
  };

  const hoverPoints =
    hx === null
      ? []
      : series.map((s) => {
          let best: [number, number] | null = null;
          let bi = -1;
          s.points.forEach((p, i) => {
            if (step ? p[0] <= hx : true) {
              if (step) {
                best = p;
                bi = i;
              } else if (!best || Math.abs(p[0] - hx) < Math.abs(best[0] - hx)) {
                best = p;
                bi = i;
              }
            }
          });
          return { s, p: best as [number, number] | null, i: bi };
        });
  const anchor = hoverPoints.find((x) => x.p)?.p ?? null;

  return (
    <div
      ref={ref}
      className="relative"
      onMouseMove={(e) => {
        const r = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
        const px = e.clientX - r.left;
        if (px < M.l || px > w - M.r) return setHx(null);
        setHx(x0 + ((px - M.l) / (w - M.l - M.r)) * (x1 - x0));
      }}
      onMouseLeave={() => setHx(null)}
    >
      <svg width={w} height={h} role="img" aria-label="Chart">
        <Axes w={w} h={h} xt={ticks(x0, x1, Math.max(2, Math.floor(w / 100)))} yt={yt} sx={sx} sy={sy} fx={fx} fy={fy} xLabel={xLabel} />
        {refs.map((r) => (
          <g key={r.label}>
            <line x1={M.l} x2={w - M.r} y1={sy(r.value)} y2={sy(r.value)} stroke={r.color ?? 'var(--critical)'} strokeWidth={1.5} />
            <text x={w - M.r - 4} y={sy(r.value) - 4} textAnchor="end" fontSize={11} fill="var(--ink-2)">
              {r.label}
            </text>
          </g>
        ))}
        {series.map((s) =>
          s.dots ? (
            <g key={s.name}>
              {s.points.map((p, i) => (
                <circle key={i} cx={sx(p[0])} cy={sy(p[1])} r={s.points.length > 400 ? 2.5 : 4} fill={s.pointColors?.[i] ?? s.color} stroke="var(--surface)" strokeWidth={s.points.length > 400 ? 0.5 : 2} />
              ))}
            </g>
          ) : (
            <g key={s.name}>
              <path d={path(s.points)} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              {s.points.length <= 40
                ? s.points.map((p, i) => <circle key={i} cx={sx(p[0])} cy={sy(p[1])} r={4} fill={s.color} stroke="var(--surface)" strokeWidth={2} />)
                : null}
            </g>
          ),
        )}
        {hx !== null && anchor ? <line x1={sx(anchor[0])} x2={sx(anchor[0])} y1={M.t} y2={h - M.b} stroke="var(--axis)" /> : null}
        {hoverPoints.map(({ s, p }) => (p ? <circle key={s.name} cx={sx(p[0])} cy={sy(p[1])} r={5} fill={s.color} stroke="var(--surface)" strokeWidth={2} /> : null))}
      </svg>
      {hx !== null && anchor ? (
        <Tooltip x={sx(anchor[0])} y={M.t + 10} width={w}>
          <div className="mb-0.5 font-semibold">{fx(anchor[0])}</div>
          {hoverPoints.map(({ s, p }) =>
            p ? (
              <div key={s.name} className="flex items-center gap-1.5">
                <span className="inline-block h-[8px] w-[8px] rounded-full" style={{ background: s.color }} />
                <span className="text-ink-2">{s.name}</span>
                <span className="num ml-auto pl-3 font-medium">{fy(p[1])}</span>
              </div>
            ) : null,
          )}
        </Tooltip>
      ) : null}
    </div>
  );
}

export function Legend({ items }: { items: { name: string; color: string; shape?: 'line' | 'dot' }[] }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-ink-2">
      {items.map((it) => (
        <span key={it.name} className="inline-flex items-center gap-1.5">
          {it.shape === 'line' ? (
            <span className="inline-block h-[2px] w-[14px] rounded" style={{ background: it.color }} />
          ) : (
            <span className="inline-block h-[9px] w-[9px] rounded-full" style={{ background: it.color }} />
          )}
          {it.name}
        </span>
      ))}
    </div>
  );
}

/** One horizontal stacked bar: where the time went. Segments separated by a 2px surface gap. */
export function StackedBar({ parts, format, height = 22 }: { parts: { label: string; value: number; color: string }[]; format: (v: number) => string; height?: number }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const total = parts.reduce((a, p) => a + p.value, 0);
  if (total <= 0) return <div className="text-muted">—</div>;
  let x = 0;
  const segs = parts.map((p) => {
    const sw = (p.value / total) * w;
    const s = { ...p, x, w: sw };
    x += sw;
    return s;
  });
  return (
    <div ref={ref} className="relative" onMouseLeave={() => setHover(null)}>
      <svg width={w} height={height}>
        {segs.map((s, i) => (
          <rect
            key={s.label}
            x={s.x + (i ? 1 : 0)}
            y={0}
            width={Math.max(0.5, s.w - (i ? 2 : 0))}
            height={height}
            rx={i === 0 || i === segs.length - 1 ? 4 : 0}
            fill={s.color}
            opacity={hover === null || hover === i ? 1 : 0.5}
            onMouseEnter={() => setHover(i)}
          />
        ))}
      </svg>
      {hover !== null ? (
        <Tooltip x={segs[hover].x + segs[hover].w / 2} y={height + 14} width={w}>
          <div className="font-semibold">{segs[hover].label}</div>
          <div className="text-ink-2">
            {format(segs[hover].value)} · {((segs[hover].value / total) * 100).toFixed(1)}%
          </div>
        </Tooltip>
      ) : null}
    </div>
  );
}

/** Averages a piecewise-constant series into pixel-wide buckets (preserving its integral). */
export function bucketize(t: number[], v: number[], end: number, buckets: number): [number, number][] {
  if (!t.length || end <= 0) return [];
  const out: [number, number][] = [];
  const bw = end / buckets;
  let i = 0;
  for (let b = 0; b < buckets; b++) {
    const s = b * bw;
    const e = s + bw;
    while (i + 1 < t.length && t[i + 1] <= s) i++;
    let area = 0;
    let j = i;
    while (j < t.length && t[j] < e) {
      const a = Math.max(s, t[j]);
      const z = Math.min(e, j + 1 < t.length ? t[j + 1] : end);
      if (z > a) area += v[j] * (z - a);
      j++;
    }
    out.push([s, area / bw]);
  }
  out.push([end, out[out.length - 1]?.[1] ?? 0]);
  return out;
}
