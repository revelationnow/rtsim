import { useEffect, useMemo, useState } from 'react';
import type { Criterion } from '../sim/sweep';
import { Legend, LineChart, type Series } from '../ui/charts';
import { Card, Empty, Field, Select, Status } from '../ui/components';
import { fmtNum, fmtPct, fmtTime } from '../ui/format';
import { seriesVar, useCompiled } from '../ui/hooks';
import { cancelRun, runSolve, runSweep } from '../ui/run';
import { useStore } from '../ui/store';

/** Splits "12.8 GB/s" into 12.8 and "GB/s"; anything else yields NaN. */
function splitValue(v: unknown): { n: number; unit: string } {
  const s = String(v ?? '').trim();
  const m = /^(-?\d+(?:\.\d+)?(?:e[-+]?\d+)?)\s*(.*)$/i.exec(s);
  return m ? { n: Number(m[1]), unit: m[2] } : { n: NaN, unit: '' };
}

const TIME_UNITS: Record<string, number> = { ps: 1, ns: 1e3, us: 1e6, ms: 1e9, s: 1e12 };

export function SweepView() {
  const model = useStore((s) => s.model);
  const sweep = useStore((s) => s.sweep);
  const c = useCompiled();
  const params = Object.keys(model.params ?? {});
  const [mode, setMode] = useState<'sweep' | 'solve'>('sweep');
  const [param, setParam] = useState(params[0] ?? '');
  useEffect(() => {
    if (!params.includes(param) && params.length) setParam(params[0]);
  }, [params, param]);

  const cur = splitValue(model.params?.[param]);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [steps, setSteps] = useState(8);
  const [unit, setUnit] = useState('');
  const [log, setLog] = useState(false);
  const [list, setList] = useState('');
  const [useList, setUseList] = useState(false);
  // Default range: half to one-and-a-half times the current value.
  useEffect(() => {
    const v = splitValue(useStore.getState().model.params?.[param]);
    if (Number.isFinite(v.n)) {
      setFrom(String(+(v.n * 0.5).toPrecision(4)));
      setTo(String(+(v.n * 1.5).toPrecision(4)));
      setUnit(v.unit);
      setUseList(false);
    } else {
      setUseList(true);
      setList(String(useStore.getState().model.params?.[param] ?? ''));
    }
  }, [param]);

  const values = useMemo(() => {
    if (useList)
      return list
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    const a = Number(from);
    const b = Number(to);
    const n = Math.max(2, Math.min(60, steps));
    if (!Number.isFinite(a) || !Number.isFinite(b)) return [];
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      const f = i / (n - 1);
      const v = log && a > 0 && b > 0 ? a * Math.pow(b / a, f) : a + (b - a) * f;
      out.push(`${+v.toPrecision(5)}${unit ? ` ${unit}` : ''}`);
    }
    return out;
  }, [useList, list, from, to, steps, unit, log]);

  if (!params.length)
    return (
      <Empty title="Add a parameter first">
        Sweeps and the solver vary a named parameter. Define one under Parameters (e.g. <code>ddr_bw = 12.8 GB/s</code>) and use it in the model.
      </Empty>
    );

  const running = sweep.status === 'running';
  return (
    <div className="mx-auto max-w-[1280px] space-y-3 p-4">
      <div className="flex gap-1">
        {(['sweep', 'solve'] as const).map((m) => (
          <button key={m} className={`btn ${mode === m ? 'primary' : ''}`} onClick={() => setMode(m)}>
            {m === 'sweep' ? 'Sweep a parameter' : 'Solve for a requirement'}
          </button>
        ))}
      </div>
      <div className="grid gap-3 lg:grid-cols-[360px_1fr]">
        <Card title={mode === 'sweep' ? 'Sweep' : 'Solve'}>
          <Field label="Parameter">
            <Select value={param} options={params} onChange={setParam} />
          </Field>
          <div className="mb-2 pl-[140px] text-[12px] text-muted">
            current: <span className="font-mono">{String(model.params?.[param])}</span>
          </div>
          {mode === 'sweep' ? (
            <>
              <Field label="Values">
                <Select
                  value={useList ? 'list' : 'range'}
                  options={[
                    { value: 'range', label: 'Range' },
                    { value: 'list', label: 'List of expressions' },
                  ]}
                  onChange={(v) => setUseList(v === 'list')}
                />
              </Field>
              {useList ? (
                <Field label="List" hint="Comma-separated, e.g. 6.4 GB/s, 8.5 GB/s, 12.8 GB/s">
                  <input className="ctl font-mono text-[12px]" value={list} onChange={(e) => setList(e.target.value)} />
                </Field>
              ) : (
                <>
                  <Field label="From / to">
                    <div className="grid grid-cols-2 gap-1.5">
                      <input className="ctl num" value={from} onChange={(e) => setFrom(e.target.value)} />
                      <input className="ctl num" value={to} onChange={(e) => setTo(e.target.value)} />
                    </div>
                  </Field>
                  <Field label="Unit">
                    <input className="ctl font-mono text-[12px]" value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="none" />
                  </Field>
                  <Field label="Points">
                    <div className="flex items-center gap-3">
                      <input className="ctl num !w-[70px]" type="number" min={2} max={60} value={steps} onChange={(e) => setSteps(Number(e.target.value))} />
                      <label className="inline-flex items-center gap-1.5">
                        <input type="checkbox" checked={log} onChange={(e) => setLog(e.target.checked)} /> log spacing
                      </label>
                    </div>
                  </Field>
                </>
              )}
              <div className="mt-1 line-clamp-2 font-mono text-[11px] text-muted">{values.join(', ')}</div>
              <div className="mt-3 flex gap-2">
                {running ? (
                  <button className="btn" onClick={cancelRun}>
                    Cancel ({Math.round(sweep.progress * 100)}%)
                  </button>
                ) : (
                  <button className="btn primary" disabled={!c.ok || !values.length} onClick={() => void runSweep({ param, values })}>
                    Run {values.length} simulations
                  </button>
                )}
              </div>
              <p className="mt-3 text-[12px] text-muted">
                Every run uses the same seed, so differences come from the parameter, not from random noise (common random numbers).
              </p>
            </>
          ) : (
            <SolveForm param={param} unitDefault={cur.unit} valueDefault={cur.n} />
          )}
        </Card>
        <div className="min-w-0 space-y-3">
          {sweep.status === 'error' ? <div className="rounded-md bg-critical-wash p-2">{sweep.error}</div> : null}
          {running ? (
            <Card>
              <div className="flex items-center gap-3">
                <div className="h-[6px] flex-1 overflow-hidden rounded-full bg-surface-3">
                  <div className="h-full bg-accent transition-all" style={{ width: `${sweep.progress * 100}%` }} />
                </div>
                <span className="text-[12px] text-ink-2">{sweep.label ?? 'starting…'}</span>
              </div>
            </Card>
          ) : null}
          {mode === 'sweep' ? <SweepResults /> : <SolveResults />}
        </div>
      </div>
    </div>
  );
}

function SweepResults() {
  const sweep = useStore((s) => s.sweep);
  const model = useStore((s) => s.model);
  const pts = sweep.points;
  if (!pts?.length) return <Card><div className="py-8 text-center text-muted">Results appear here: worst response against deadline, misses and utilization for each value.</div></Card>;
  const ok = pts.filter((p) => p.ok && p.metrics);
  const xs = pts.map((p, i) => {
    const n = splitValue(p.value).n;
    return Number.isFinite(n) ? n : i;
  });
  const unit = splitValue(pts[0].value).unit;
  const wpIdx = new Map(model.workplans.map((w, i) => [w.id, i]));
  const wps = ok[0]?.metrics!.workplans ?? [];
  const deadlines = new Map(model.workplans.map((w) => [w.id, w.deadline]));
  const withDeadline = wps.filter((w) => deadlines.get(w.id) !== undefined);
  const dlPs = (id: string) => {
    const r = useStore.getState().run.result?.workplans.find((w) => w.id === id)?.deadlinePs;
    if (r) return r;
    const s = splitValue(deadlines.get(id));
    return TIME_UNITS[s.unit] ? s.n * TIME_UNITS[s.unit] : null;
  };

  const ratio: Series[] = withDeadline
    .map((w) => {
      const d = dlPs(w.id);
      if (!d) return null;
      return {
        name: w.id,
        color: seriesVar(wpIdx.get(w.id) ?? 99),
        points: pts.flatMap((p, i) => (p.metrics ? [[xs[i], p.metrics.workplans.find((x) => x.id === w.id)!.max / d] as [number, number]] : [])),
      };
    })
    .filter((s): s is Series => s !== null)
    .slice(0, 8);
  const misses: Series[] = wps
    .map((w) => ({
      name: w.id,
      color: seriesVar(wpIdx.get(w.id) ?? 99),
      points: pts.flatMap((p, i) => (p.metrics ? [[xs[i], p.metrics.workplans.find((x) => x.id === w.id)!.failRate] as [number, number]] : [])),
    }))
    .filter((s) => s.points.some((p) => p[1] > 0))
    .slice(0, 8);
  const res = ok[0]?.metrics!.resources ?? [];
  const busiest = [...res]
    .map((r) => ({ id: r.id, max: Math.max(...ok.map((p) => p.metrics!.resources.find((x) => x.id === r.id)!.utilization)) }))
    .sort((a, b) => b.max - a.max)
    .slice(0, 4);
  const util: Series[] = busiest.map((b, i) => ({
    name: b.id,
    color: `var(--series-${i + 1})`,
    points: pts.flatMap((p, k) => (p.metrics ? [[xs[k], p.metrics.resources.find((x) => x.id === b.id)!.utilization] as [number, number]] : [])),
  }));
  const fx = (v: number, d = 4) => `${fmtNum(v, d)}${unit ? ` ${unit}` : ''}`;

  return (
    <>
      <div className="grid gap-3 xl:grid-cols-2">
        <Card title="Worst response ÷ deadline">
          <LineChart series={ratio} fx={fx} fy={(v) => `${fmtNum(v, 3)}×`} refs={[{ value: 1, label: 'deadline' }]} xLabel={sweep.param} />
          <div className="mt-1">
            <Legend items={ratio.map((s) => ({ name: s.name, color: s.color }))} />
          </div>
          <p className="mt-1 text-[11.5px] text-muted">Below 1 means every job met its deadline. Workplans without a deadline are omitted.</p>
        </Card>
        <Card title="Missed or skipped activations">
          {misses.length ? (
            <>
              <LineChart series={misses} fx={fx} fy={(v) => fmtPct(v, 1)} yMin={0} xLabel={sweep.param} />
              <div className="mt-1">
                <Legend items={misses.map((s) => ({ name: s.name, color: s.color }))} />
              </div>
            </>
          ) : (
            <div className="py-10 text-center">
              <Status ok text="No misses at any value" />
            </div>
          )}
        </Card>
        <Card title="Average utilization of the busiest resources" className="xl:col-span-2">
          <LineChart series={util} fx={fx} fy={(v) => fmtPct(v, 0)} yMin={0} xLabel={sweep.param} />
          <div className="mt-1">
            <Legend items={util.map((s) => ({ name: s.name, color: s.color }))} />
          </div>
        </Card>
      </div>
      <Card title="All runs" pad={false}>
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>{sweep.param}</th>
                {wps.map((w) => (
                  <th key={w.id} className="r">
                    {w.id} max
                  </th>
                ))}
                <th className="r">misses</th>
              </tr>
            </thead>
            <tbody>
              {pts.map((p) => (
                <tr key={p.value}>
                  <td className="font-mono">{p.value}</td>
                  {p.metrics ? (
                    <>
                      {p.metrics.workplans.map((w) => (
                        <td key={w.id} className="r">
                          {fmtTime(w.max)}
                        </td>
                      ))}
                      <td className="r">
                        {p.metrics.workplans.reduce((a, w) => a + w.missed + w.skipped, 0) ? (
                          <span className="font-semibold text-critical">{p.metrics.workplans.reduce((a, w) => a + w.missed + w.skipped, 0)}</span>
                        ) : (
                          <span className="text-good-ink">0</span>
                        )}
                      </td>
                    </>
                  ) : (
                    <td colSpan={wps.length + 1} className="text-critical">
                      {p.error}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

function SolveForm({ param, unitDefault, valueDefault }: { param: string; unitDefault: string; valueDefault: number }) {
  const model = useStore((s) => s.model);
  const sweep = useStore((s) => s.sweep);
  const [lo, setLo] = useState('');
  const [hi, setHi] = useState('');
  const [unit, setUnit] = useState(unitDefault);
  const [ctype, setCtype] = useState<Criterion['type']>('deadlines');
  const [target, setTarget] = useState('');
  const [limit, setLimit] = useState('');
  const [tol, setTol] = useState(0.5);
  useEffect(() => {
    if (Number.isFinite(valueDefault)) {
      setLo(String(+(valueDefault * 0.1).toPrecision(3)));
      setHi(String(+(valueDefault * 2).toPrecision(3)));
    }
    setUnit(unitDefault);
  }, [param, unitDefault, valueDefault]);
  const wps = model.workplans.map((w) => w.id);
  const runResult = useStore((s) => s.run.result);
  const resources = useMemo(() => runResult?.resources.map((r) => r.id) ?? [], [runResult]);

  const criterion = (): Criterion | null => {
    if (ctype === 'deadlines') return { type: 'deadlines', workplan: target || undefined };
    if (ctype === 'p99' || ctype === 'max') {
      const s = splitValue(limit);
      const mult = TIME_UNITS[s.unit] ?? NaN;
      if (!target || !Number.isFinite(s.n * mult)) return null;
      return { type: ctype, workplan: target, limitPs: s.n * mult };
    }
    const l = Number(limit) / 100;
    if (!target || !Number.isFinite(l)) return null;
    return { type: 'util', resource: target, limit: l };
  };
  const crit = criterion();
  const running = sweep.status === 'running';

  return (
    <>
      <Field label="Search range">
        <div className="grid grid-cols-2 gap-1.5">
          <input className="ctl num" value={lo} onChange={(e) => setLo(e.target.value)} />
          <input className="ctl num" value={hi} onChange={(e) => setHi(e.target.value)} />
        </div>
      </Field>
      <Field label="Unit">
        <input className="ctl font-mono text-[12px]" value={unit} onChange={(e) => setUnit(e.target.value)} placeholder="none" />
      </Field>
      <Field label="Requirement">
        <Select
          value={ctype}
          options={[
            { value: 'deadlines', label: 'No deadline misses' },
            { value: 'max', label: 'Worst response ≤ limit' },
            { value: 'p99', label: 'p99 response ≤ limit' },
            { value: 'util', label: 'Average utilization ≤ limit' },
          ]}
          onChange={(v) => {
            setCtype(v);
            setTarget('');
          }}
        />
      </Field>
      <Field label={ctype === 'util' ? 'Resource' : 'Workplan'}>
        <Select
          value={target}
          options={[
            ...(ctype === 'deadlines' ? [{ value: '', label: 'all workplans' }] : [{ value: '', label: 'choose…' }]),
            ...(ctype === 'util' ? resources : wps).map((x) => ({ value: x, label: x })),
          ]}
          onChange={setTarget}
        />
      </Field>
      {ctype !== 'deadlines' ? (
        <Field label="Limit" hint={ctype === 'util' ? 'Percent' : 'A time, e.g. 20 ms'}>
          <input className="ctl font-mono text-[12px]" value={limit} onChange={(e) => setLimit(e.target.value)} placeholder={ctype === 'util' ? '70' : '20 ms'} />
        </Field>
      ) : null}
      <Field label="Precision">
        <Select
          value={String(tol)}
          options={[
            { value: '2', label: '2% of range' },
            { value: '0.5', label: '0.5% of range' },
            { value: '0.1', label: '0.1% of range' },
          ]}
          onChange={(v) => setTol(Number(v))}
        />
      </Field>
      <div className="mt-3">
        {running ? (
          <button className="btn" onClick={cancelRun}>
            Cancel
          </button>
        ) : (
          <button
            className="btn primary"
            disabled={!crit || !Number.isFinite(Number(lo)) || !Number.isFinite(Number(hi))}
            onClick={() => crit && void runSolve({ param, lo: Number(lo), hi: Number(hi), unit, criterion: crit, tolerance: tol / 100 })}
          >
            Solve
          </button>
        )}
      </div>
      <p className="mt-3 text-[12px] text-muted">
        Bisection: assumes the requirement gets easier to meet as the parameter moves in one direction (more bandwidth, clock or cores never hurts). Each
        trial is a full simulation with the same seed.
      </p>
    </>
  );
}

function SolveResults() {
  const sweep = useStore((s) => s.sweep);
  const s = sweep.solve;
  if (!s) return <Card><div className="py-8 text-center text-muted">Find the smallest (or largest) parameter value that meets a requirement — e.g. the minimum DDR bandwidth with no deadline misses.</div></Card>;
  const pass = s.trials.filter((t) => t.pass).map((t) => [t.value, 1] as [number, number]);
  const fail = s.trials.filter((t) => !t.pass).map((t) => [t.value, 0] as [number, number]);
  return (
    <>
      <Card>
        <div className="flex items-center gap-3">
          <Status ok={s.status === 'found' ? true : s.status === 'all-pass' ? 'warn' : false} text={s.message} />
        </div>
        {s.status === 'found' && s.value !== undefined ? (
          <div className="mt-3 text-[28px] font-semibold">
            {sweep.param} {s.direction === 'min' ? '≥' : '≤'} {fmtNum(s.value, 4)} {s.unit}
          </div>
        ) : null}
      </Card>
      <Card title="Trials">
        <LineChart
          series={[
            { name: 'passes', color: 'var(--good)', points: pass, dots: true },
            { name: 'fails', color: 'var(--critical)', points: fail, dots: true },
          ]}
          fx={(v, d) => fmtNum(v, d ?? 4)}
          fy={(v) => (v === 1 ? 'pass' : v === 0 ? 'fail' : '')}
          yMin={-0.2}
          yMax={1.2}
          height={150}
        />
        <Legend items={[{ name: 'passes', color: 'var(--good)' }, { name: 'fails', color: 'var(--critical)' }]} />
        <div className="overflow-x-auto mt-2">
        <table className="tbl">
          <thead>
            <tr>
              <th>#</th>
              <th className="r">Value</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {s.trials.map((t, i) => (
              <tr key={i}>
                <td>{i + 1}</td>
                <td className="r">{fmtNum(t.value, 6)}</td>
                <td>{t.error ? <span className="text-critical">{t.error}</span> : <Status ok={t.pass} text={t.pass ? 'pass' : 'fail'} />}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </Card>
    </>
  );
}
