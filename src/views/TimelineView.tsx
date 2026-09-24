import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { COMPUTE_STRIDE, TRANSFER_STRIDE, type SimResult } from '../sim/result';
import { bucketize, Legend, useWidth } from '../ui/charts';
import { Empty } from '../ui/components';
import { fmtBytes, fmtRate, fmtTime, ticks } from '../ui/format';
import { seriesKey, seriesVar, useCssColors } from '../ui/hooks';
import { runSimulation } from '../ui/run';
import { useStore } from '../ui/store';

const LABEL_W = 176;
const AXIS_H = 26;
const GROUP_H = 20;

interface Bar {
  t0: number;
  t1: number;
  row: number;
  wp: number;
  job: number;
  step: number;
  missed?: boolean;
  /** Index into the flat trace array (transfers), for details. */
  ref?: number;
  core?: number;
}

interface Lane {
  key: string;
  label: string;
  sub?: string;
  group: string;
  kind: 'jobs' | 'compute' | 'transfers' | 'util';
  h: number;
  rows: number;
  bars: Bar[];
  util?: { t: number[]; v: number[] };
  resId?: string;
  deadline?: number | null;
}

/** Greedy interval packing into at most `maxRows` rows (overflow shares the least-busy row). */
function pack(bars: Bar[], maxRows: number): number {
  bars.sort((a, b) => a.t0 - b.t0 || a.t1 - b.t1);
  const ends: number[] = [];
  for (const b of bars) {
    let r = ends.findIndex((e) => e <= b.t0);
    if (r < 0) {
      if (ends.length < maxRows) r = ends.length;
      else r = ends.indexOf(Math.min(...ends));
      ends[r] = b.t1;
    } else ends[r] = b.t1;
    b.row = r;
  }
  return Math.max(1, ends.length);
}

function buildLanes(r: SimResult, names: { wpNames: string[] }): Lane[] {
  const lanes: Lane[] = [];
  const n = r.names;
  // Workplans: one bar per job, activation → completion.
  r.workplans.forEach((w, wi) => {
    const bars: Bar[] = w.jobs.map((j) => ({
      t0: j.activation,
      t1: j.completion >= 0 ? j.completion : r.durationPs,
      row: 0,
      wp: wi,
      job: j.idx,
      step: -1,
      missed: j.missed,
    }));
    const rows = pack(bars, 4);
    lanes.push({ key: `wp:${w.id}`, label: names.wpNames[wi] ?? w.id, sub: `${w.jobs.length} jobs`, group: 'Workplans', kind: 'jobs', h: Math.max(22, rows * 9 + 8), rows, bars, deadline: w.deadlinePs });
  });
  // Processor cores.
  const perCore = new Map<string, Bar[]>();
  const tc = r.trace.compute;
  for (let i = 0; i < tc.length; i += COMPUTE_STRIDE) {
    const key = `${tc[i]}:${tc[i + 1]}`;
    if (!perCore.has(key)) perCore.set(key, []);
    perCore.get(key)!.push({ t0: tc[i + 2], t1: tc[i + 3], row: 0, wp: tc[i + 4], job: tc[i + 5], step: tc[i + 6], core: tc[i + 1] });
  }
  n.procs.forEach((p, pi) => {
    for (let c = 0; c < n.procCores[pi]; c++) {
      const bars = perCore.get(`${pi}:${c}`) ?? [];
      bars.sort((a, b) => a.t0 - b.t0);
      const res = r.resources.find((x) => x.id === p && x.kind === 'processor');
      lanes.push({
        key: `core:${p}:${c}`,
        label: n.procCores[pi] > 1 ? `${res?.name ?? p} #${c}` : (res?.name ?? p),
        sub: c === 0 && res ? `${(res.utilization * 100).toFixed(1)}% busy` : undefined,
        group: 'Processors',
        kind: 'compute',
        h: 20,
        rows: 1,
        bars,
      });
    }
  });
  // DMA engines: transfers queued on each, packed by channel.
  const tt = r.trace.transfers;
  n.dmas.forEach((d, di) => {
    const bars: Bar[] = [];
    for (let i = 0; i < tt.length; i += TRANSFER_STRIDE) {
      if (n.transferDma[tt[i]]?.[tt[i + 2]] !== d) continue;
      bars.push({ t0: tt[i + 4], t1: tt[i + 6], row: 0, wp: tt[i], job: tt[i + 1], step: tt[i + 2], ref: i });
    }
    const rows = pack(bars, n.dmaChannels[di]);
    lanes.push({ key: `dma:${d}`, label: d, sub: `${n.dmaChannels[di]} ch`, group: 'DMA', kind: 'transfers', h: Math.max(20, rows * 8 + 6), rows, bars });
  });
  // Links: exact utilization over time.
  for (const res of r.resources) {
    if (res.kind !== 'bus' && res.kind !== 'memory') continue;
    lanes.push({
      key: `link:${res.id}`,
      label: res.name,
      sub: `${(res.utilization * 100).toFixed(1)}% avg`,
      group: 'Buses & memories',
      kind: 'util',
      h: 30,
      rows: 1,
      bars: [],
      util: res.series,
      resId: res.id,
    });
  }
  return lanes;
}

interface Hover {
  x: number;
  y: number;
  lines: string[];
  title: string;
}

export function TimelineView() {
  const run = useStore((s) => s.run);
  const model = useStore((s) => s.model);
  const focusJob = useStore((s) => s.focusJob);
  const setFocusJob = useStore((s) => s.setFocusJob);
  const r = run.result;
  const colors = useCssColors();
  const [wrapRef, width] = useWidth<HTMLDivElement>();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [win, setWin] = useState<{ t0: number; t1: number }>({ t0: 0, t1: r?.durationPs ?? 1 });
  const [hover, setHover] = useState<Hover | null>(null);
  const drag = useRef<{ x: number; t0: number; t1: number; moved: boolean } | null>(null);

  const wpNames = useMemo(() => (run.ranModel ?? model).workplans.map((w) => w.name || w.id), [run.ranModel, model]);
  const lanes = useMemo(() => (r ? buildLanes(r, { wpNames }) : []), [r, wpNames]);
  const layout = useMemo(() => {
    const ys: number[] = [];
    let y = AXIS_H;
    let group = '';
    const headers: { y: number; label: string }[] = [];
    for (const l of lanes) {
      if (l.group !== group) {
        group = l.group;
        headers.push({ y, label: group });
        y += GROUP_H;
      }
      ys.push(y);
      y += l.h;
    }
    return { ys, headers, height: y + 8 };
  }, [lanes]);

  const focusIdx = useMemo(() => {
    if (!focusJob || !r) return null;
    const wi = r.workplans.findIndex((w) => w.id === focusJob.wp);
    return wi < 0 ? null : { wp: wi, job: focusJob.job };
  }, [focusJob, r]);

  // When asked to focus a job, zoom to it.
  useEffect(() => {
    if (!r || !focusIdx) return;
    const j = r.workplans[focusIdx.wp].jobs[focusIdx.job];
    if (!j) return;
    const end = j.completion >= 0 ? j.completion : r.durationPs;
    const pad = Math.max((end - j.activation) * 0.15, 1000);
    setWin({ t0: Math.max(0, j.activation - pad), t1: Math.min(r.durationPs, end + pad) });
  }, [focusIdx, r]);

  useEffect(() => {
    if (r) setWin((w) => (w.t1 > r.durationPs || w.t1 <= w.t0 ? { t0: 0, t1: r.durationPs } : w));
  }, [r]);

  const plotW = Math.max(50, width - LABEL_W - 8);
  const tx = useCallback((t: number) => LABEL_W + ((t - win.t0) / (win.t1 - win.t0)) * plotW, [win, plotW]);

  // ---- drawing ---------------------------------------------------------------
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !r) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.floor(width * dpr);
    cv.height = Math.floor(layout.height * dpr);
    cv.style.width = `${width}px`;
    cv.style.height = `${layout.height}px`;
    const g = cv.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, width, layout.height);
    g.fillStyle = colors.surface;
    g.fillRect(0, 0, width, layout.height);
    const wpColor = (wi: number) => colors[seriesKey(wi)] || colors.muted;
    const span = win.t1 - win.t0;
    const visible = (a: number, b: number) => b >= win.t0 && a <= win.t1;
    const dim = (wi: number, job: number) => focusIdx !== null && !(focusIdx.wp === wi && focusIdx.job === job);

    // time grid
    const tks = ticks(win.t0, win.t1, Math.max(3, Math.floor(plotW / 110)));
    g.font = '11px system-ui, -apple-system, Segoe UI, sans-serif';
    g.textBaseline = 'middle';
    g.textAlign = 'center';
    for (const t of tks) {
      const x = tx(t);
      g.strokeStyle = colors.grid;
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(Math.round(x) + 0.5, AXIS_H);
      g.lineTo(Math.round(x) + 0.5, layout.height);
      g.stroke();
      g.fillStyle = colors.muted;
      g.fillText(fmtTime(t, 4), x, AXIS_H / 2);
    }
    g.strokeStyle = colors.axis;
    g.beginPath();
    g.moveTo(LABEL_W, AXIS_H - 0.5);
    g.lineTo(width, AXIS_H - 0.5);
    g.stroke();

    // group headers
    for (const h of layout.headers) {
      g.fillStyle = colors['surface-2'];
      g.fillRect(0, h.y, width, GROUP_H);
      g.fillStyle = colors['ink-2'];
      g.textAlign = 'left';
      g.font = '600 11px system-ui, -apple-system, Segoe UI, sans-serif';
      g.fillText(h.label.toUpperCase(), 10, h.y + GROUP_H / 2);
    }

    g.save();
    g.beginPath();
    g.rect(LABEL_W, 0, plotW + 8, layout.height);
    g.clip();
    lanes.forEach((lane, li) => {
      const y0 = layout.ys[li];
      g.strokeStyle = colors.line;
      g.beginPath();
      g.moveTo(0, y0 + lane.h - 0.5);
      g.lineTo(width, y0 + lane.h - 0.5);
      g.stroke();
      if (lane.kind === 'util' && lane.util) {
        const pts = bucketize(lane.util.t, lane.util.v, r.durationPs, Math.min(4000, Math.max(50, Math.floor((plotW * r.durationPs) / span))));
        const top = y0 + 3;
        const hh = lane.h - 6;
        g.beginPath();
        g.moveTo(tx(0), top + hh);
        for (const [t, v] of pts) g.lineTo(tx(t), top + hh - Math.min(1, v) * hh);
        g.lineTo(tx(r.durationPs), top + hh);
        g.closePath();
        g.fillStyle = colors['accent-wash'];
        g.fill();
        g.beginPath();
        pts.forEach(([t, v], i) => (i ? g.lineTo(tx(t), top + hh - Math.min(1, v) * hh) : g.moveTo(tx(t), top + hh - Math.min(1, v) * hh)));
        g.strokeStyle = colors.accent;
        g.lineWidth = 1.25;
        g.stroke();
        return;
      }
      const rowH = lane.kind === 'jobs' ? 7 : lane.kind === 'compute' ? lane.h - 6 : 6;
      const gap = lane.kind === 'jobs' ? 9 : 8;
      let lastX = -1;
      let lastRow = -1;
      for (const b of lane.bars) {
        if (!visible(b.t0, b.t1)) continue;
        const x0 = tx(b.t0);
        const x1 = tx(b.t1);
        const w = Math.max(1, x1 - x0);
        // Sub-pixel bars in the same column collapse into one to keep drawing cheap.
        if (w <= 1 && Math.round(x0) === lastX && b.row === lastRow && focusIdx === null) continue;
        lastX = Math.round(x0);
        lastRow = b.row;
        const y = lane.kind === 'compute' ? y0 + 3 : y0 + 4 + b.row * gap;
        const isDim = dim(b.wp, b.job);
        g.globalAlpha = isDim ? 0.18 : 1;
        g.fillStyle = b.missed ? colors.critical : wpColor(b.wp);
        if (w > 4) {
          g.beginPath();
          g.roundRect(x0, y, w, rowH, Math.min(3, rowH / 2));
          g.fill();
        } else g.fillRect(x0, y, w, rowH);
        if (lane.kind === 'jobs' && lane.deadline != null && w > 3) {
          const dx = tx(b.t0 + lane.deadline);
          if (dx > x0 && dx < LABEL_W + plotW + 8) {
            g.fillStyle = colors['ink-2'];
            g.fillRect(dx - 0.5, y - 2, 1.5, rowH + 4);
          }
        }
        if (lane.kind === 'compute' && w > 60) {
          g.globalAlpha = isDim ? 0.25 : 1;
          g.fillStyle = '#fff';
          g.textAlign = 'left';
          g.font = '11px system-ui, -apple-system, Segoe UI, sans-serif';
          const txt = `${r.names.steps[b.wp]?.[b.step] ?? ''} #${b.job}`;
          g.fillText(txt, x0 + 4, y + rowH / 2, w - 8);
        }
      }
      g.globalAlpha = 1;
    });
    g.restore();

    // labels
    g.textAlign = 'left';
    lanes.forEach((lane, li) => {
      const y0 = layout.ys[li];
      g.fillStyle = colors.surface;
      g.fillRect(0, y0, LABEL_W - 1, lane.h - 1);
      g.fillStyle = colors.ink;
      g.font = '12px system-ui, -apple-system, Segoe UI, sans-serif';
      const mid = y0 + lane.h / 2;
      if (lane.kind === 'jobs') {
        g.fillStyle = wpColor(lanes.filter((l) => l.kind === 'jobs').indexOf(lane));
        g.beginPath();
        g.roundRect(10, mid - 5, 10, 10, 3);
        g.fill();
        g.fillStyle = colors.ink;
      }
      const x = lane.kind === 'jobs' ? 26 : 10;
      if (lane.sub && lane.h >= 26) {
        g.fillText(lane.label, x, mid - 6, LABEL_W - x - 6);
        g.fillStyle = colors.muted;
        g.font = '10.5px system-ui, -apple-system, Segoe UI, sans-serif';
        g.fillText(lane.sub, x, mid + 7, LABEL_W - x - 6);
      } else {
        g.fillText(lane.label, x, mid, LABEL_W - x - 6);
      }
    });
    g.strokeStyle = colors.line;
    g.beginPath();
    g.moveTo(LABEL_W - 0.5, 0);
    g.lineTo(LABEL_W - 0.5, layout.height);
    g.stroke();
  }, [r, lanes, layout, width, colors, win, tx, plotW, focusIdx]);

  // ---- interaction -------------------------------------------------------------
  const pick = (mx: number, my: number): { lane: Lane; bar?: Bar; t: number } | null => {
    if (mx < LABEL_W) return null;
    const li = layout.ys.findIndex((y, i) => my >= y && my < y + lanes[i].h);
    if (li < 0) return null;
    const lane = lanes[li];
    const t = win.t0 + ((mx - LABEL_W) / plotW) * (win.t1 - win.t0);
    const tol = ((win.t1 - win.t0) / plotW) * 2;
    if (lane.kind === 'util') return { lane, t };
    const row = lane.kind === 'compute' ? 0 : Math.max(0, Math.floor((my - layout.ys[li] - 4) / (lane.kind === 'jobs' ? 9 : 8)));
    let best: Bar | undefined;
    for (const b of lane.bars) {
      if (b.row !== row && lane.kind !== 'compute') continue;
      if (b.t0 - tol <= t && t <= b.t1 + tol) {
        if (!best || b.t1 - b.t0 < best.t1 - best.t0) best = b;
      }
    }
    return { lane, bar: best, t };
  };

  const describe = (p: { lane: Lane; bar?: Bar; t: number }): Omit<Hover, 'x' | 'y'> | null => {
    if (!r) return null;
    const n = r.names;
    if (p.lane.kind === 'util' && p.lane.util) {
      const { t: ts, v } = p.lane.util;
      let i = 0;
      while (i + 1 < ts.length && ts[i + 1] <= p.t) i++;
      const active: string[] = [];
      const tt = r.trace.transfers;
      for (let k = 0; k < tt.length && active.length < 8; k += TRANSFER_STRIDE) {
        if (tt[k + 5] <= p.t && p.t < tt[k + 6] && n.transferRes[tt[k]]?.[tt[k + 2]]?.includes(p.lane.resId!)) {
          active.push(`${n.wps[tt[k]]}.${n.steps[tt[k]][tt[k + 2]]} #${tt[k + 1]} · ${fmtBytes(tt[k + 7])}`);
        }
      }
      return { title: `${p.lane.label} at ${fmtTime(p.t, 4)}`, lines: [`utilization ${(v[i] * 100).toFixed(1)}%`, ...(active.length ? active : ['no transfer streaming'])] };
    }
    const b = p.bar;
    if (!b) return null;
    const wpName = wpNames[b.wp] ?? n.wps[b.wp];
    if (p.lane.kind === 'jobs') {
      const j = r.workplans[b.wp].jobs[b.job];
      const dl = n.deadlines[b.wp];
      return {
        title: `${wpName} · job #${b.job}`,
        lines: [
          `activated ${fmtTime(j.activation, 5)}`,
          j.completion >= 0 ? `response ${fmtTime(j.completion - j.activation, 4)}` : 'unfinished at end of run',
          ...(dl != null ? [`deadline ${fmtTime(dl)} — ${j.missed ? 'MISSED' : 'met'}`] : []),
          ...(j.origin !== j.activation ? [`chain origin ${fmtTime(j.origin, 5)}`] : []),
          'click to trace this job',
        ],
      };
    }
    const step = n.steps[b.wp]?.[b.step];
    if (p.lane.kind === 'compute') {
      return { title: `${wpName}.${step} · job #${b.job}`, lines: [`${fmtTime(b.t0, 5)} → ${fmtTime(b.t1, 5)}`, `ran ${fmtTime(b.t1 - b.t0, 4)} on this core`] };
    }
    const k = b.ref!;
    const tt = r.trace.transfers;
    const bytes = tt[k + 7];
    const stream = tt[k + 6] - tt[k + 5];
    return {
      title: `${wpName}.${step} · job #${b.job}`,
      lines: [
        `${fmtBytes(bytes)} · waited ${fmtTime(tt[k + 4] - tt[k + 3])} for a channel`,
        `latency ${fmtTime(tt[k + 5] - tt[k + 4])}, streaming ${fmtTime(stream)}`,
        stream > 0 ? `average ${fmtRate((bytes / stream) * 1e12)}` : '',
      ].filter(Boolean),
    };
  };

  const onWheel = (e: React.WheelEvent) => {
    if (!r) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const span = win.t1 - win.t0;
    if (e.ctrlKey || e.metaKey || e.altKey) {
      e.preventDefault();
      const f = Math.exp(e.deltaY * 0.0025);
      const at = win.t0 + (Math.max(0, mx - LABEL_W) / plotW) * span;
      zoomAt(at, f);
    } else if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      pan((e.deltaX / plotW) * span);
    }
  };

  const zoomAt = (at: number, f: number) => {
    if (!r) return;
    setWin((w) => {
      const span = w.t1 - w.t0;
      const ns = Math.min(r.durationPs, Math.max(1000, span * f));
      let t0 = at - ((at - w.t0) / span) * ns;
      t0 = Math.max(0, Math.min(r.durationPs - ns, t0));
      return { t0, t1: t0 + ns };
    });
  };
  const pan = (dt: number) => {
    if (!r) return;
    setWin((w) => {
      const span = w.t1 - w.t0;
      const t0 = Math.max(0, Math.min(r.durationPs - span, w.t0 + dt));
      return { t0, t1: t0 + span };
    });
  };

  // Block page zoom on ctrl+wheel over the canvas (React's wheel listener is passive).
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const stop = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) e.preventDefault();
    };
    el.addEventListener('wheel', stop, { passive: false });
    return () => el.removeEventListener('wheel', stop);
  });

  if (!r)
    return (
      <Empty title="No run to show">
        Run the simulation first.
        <div className="mt-3">
          <button className="btn primary" onClick={() => void runSimulation()}>
            ▶ Run simulation
          </button>
        </div>
      </Empty>
    );

  const focusDetails = focusIdx ? r.workplans[focusIdx.wp] : null;
  const fj = focusDetails?.jobs[focusIdx!.job];

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-3 py-2">
        <button className="btn sm" onClick={() => setWin({ t0: 0, t1: r.durationPs })}>
          Fit
        </button>
        <button className="btn sm" onClick={() => zoomAt((win.t0 + win.t1) / 2, 0.5)}>
          Zoom in
        </button>
        <button className="btn sm" onClick={() => zoomAt((win.t0 + win.t1) / 2, 2)}>
          Zoom out
        </button>
        <button className="btn sm" onClick={() => pan(-(win.t1 - win.t0) * 0.5)}>
          ◀
        </button>
        <button className="btn sm" onClick={() => pan((win.t1 - win.t0) * 0.5)}>
          ▶
        </button>
        <span className="num text-[12px] text-ink-2">
          {fmtTime(win.t0, 5)} – {fmtTime(win.t1, 5)} ({fmtTime(win.t1 - win.t0)} shown)
        </span>
        <span className="text-[11.5px] text-muted">Ctrl/⌘ + wheel to zoom · drag to pan · click a bar to trace its job</span>
        <div className="flex-1" />
        <Legend
          items={[
            ...wpNames.slice(0, 8).map((nm, i) => ({ name: nm, color: seriesVar(i) })),
            { name: 'missed deadline', color: 'var(--critical)' },
          ]}
        />
      </div>
      {focusDetails && fj ? (
        <div className="flex flex-wrap items-center gap-3 border-b border-line bg-accent-wash px-3 py-1.5 text-[12px]">
          <span className="font-semibold">
            Tracing {wpNames[focusIdx!.wp]} job #{fj.idx}
          </span>
          <span>activated {fmtTime(fj.activation, 5)}</span>
          <span>{fj.completion >= 0 ? `response ${fmtTime(fj.completion - fj.activation, 4)}` : 'unfinished'}</span>
          {fj.missed ? <span className="font-semibold text-critical">missed deadline</span> : null}
          <button className="btn sm" onClick={() => setFocusJob(null)}>
            Clear
          </button>
        </div>
      ) : null}
      {r.trace.truncated ? (
        <div className="bg-surface-2 px-3 py-1 text-[12px] text-ink-2">
          The timeline holds the first {(r.trace.compute.length / COMPUTE_STRIDE + r.trace.transfers.length / TRANSFER_STRIDE).toLocaleString()} segments;
          later activity is not drawn (statistics are complete). Raise the timeline limit in Parameters to record more.
        </div>
      ) : null}
      <div ref={wrapRef} className="relative min-h-0 flex-1 overflow-auto">
        <canvas
          ref={canvasRef}
          className="block cursor-crosshair"
          onWheel={onWheel}
          onMouseDown={(e) => {
            drag.current = { x: e.clientX, t0: win.t0, t1: win.t1, moved: false };
          }}
          onMouseMove={(e) => {
            const rect = (e.currentTarget as HTMLCanvasElement).getBoundingClientRect();
            const mx = e.clientX - rect.left;
            const my = e.clientY - rect.top;
            if (drag.current) {
              const dx = e.clientX - drag.current.x;
              if (Math.abs(dx) > 3) drag.current.moved = true;
              if (drag.current.moved) {
                const span = drag.current.t1 - drag.current.t0;
                const t0 = Math.max(0, Math.min(r.durationPs - span, drag.current.t0 - (dx / plotW) * span));
                setWin({ t0, t1: t0 + span });
                setHover(null);
                return;
              }
            }
            const p = pick(mx, my);
            const d = p && describe(p);
            setHover(d ? { ...d, x: mx, y: my } : null);
          }}
          onMouseUp={(e) => {
            const wasDrag = drag.current?.moved;
            drag.current = null;
            if (wasDrag) return;
            const rect = (e.currentTarget as HTMLCanvasElement).getBoundingClientRect();
            const p = pick(e.clientX - rect.left, e.clientY - rect.top);
            if (p?.bar) {
              const same = focusIdx && focusIdx.wp === p.bar.wp && focusIdx.job === p.bar.job;
              setFocusJob(same ? null : { wp: r.workplans[p.bar.wp].id, job: p.bar.job });
            }
          }}
          onMouseLeave={() => {
            drag.current = null;
            setHover(null);
          }}
        />
        {hover ? (
          <div
            className="pointer-events-none absolute z-20 max-w-[380px] rounded-md border border-line bg-surface px-2.5 py-1.5 text-[11.5px] shadow-md"
            style={{ left: hover.x > width - 320 ? hover.x - 12 : hover.x + 14, top: hover.y + 14, transform: hover.x > width - 320 ? 'translateX(-100%)' : undefined }}
          >
            <div className="font-semibold">{hover.title}</div>
            {hover.lines.map((l, i) => (
              <div key={i} className="text-ink-2">
                {l}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
