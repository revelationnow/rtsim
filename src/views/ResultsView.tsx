import { useMemo, useState } from 'react';
import type { ResourceResult, SimResult, WorkplanResult } from '../sim/result';
import { bucketize, Histogram, Legend, LineChart, StackedBar, useWidth } from '../ui/charts';
import { Card, Empty, Status, Swatch, Tile, UtilBar } from '../ui/components';
import { fmtBytes, fmtNum, fmtPct, fmtRate, fmtTime } from '../ui/format';
import { seriesVar } from '../ui/hooks';
import { runSimulation } from '../ui/run';
import { useStore } from '../ui/store';

/** Time categories along the critical path, in a fixed color order. */
export const CATEGORY: { key: string; label: string; color: string }[] = [
  { key: 'Exec', label: 'Executing', color: 'var(--series-1)' },
  { key: 'Queue', label: 'Waiting for a core', color: 'var(--series-2)' },
  { key: 'Transfer', label: 'Moving data', color: 'var(--series-3)' },
  { key: 'Contention', label: 'Slowed by contention', color: 'var(--series-4)' },
  { key: 'Preempted', label: 'Preempted', color: 'var(--series-5)' },
  { key: 'Latency', label: 'Access latency', color: 'var(--series-6)' },
  { key: 'DMA wait', label: 'Waiting for DMA', color: 'var(--series-7)' },
  { key: 'Delay', label: 'Delay / release jitter', color: 'var(--muted)' },
];

export function categoryOf(k: string): string {
  if (k.startsWith('Exec')) return 'Exec';
  if (k.startsWith('Queue')) return 'Queue';
  if (k.startsWith('Preempted')) return 'Preempted';
  if (k.startsWith('DMA wait')) return 'DMA wait';
  if (k === 'Release delay') return 'Delay';
  return k;
}

function groupParts(parts: Record<string, number>): { label: string; value: number; color: string }[] {
  const sums = new Map<string, number>();
  for (const [k, v] of Object.entries(parts)) sums.set(categoryOf(k), (sums.get(categoryOf(k)) ?? 0) + v);
  return CATEGORY.filter((c) => (sums.get(c.key) ?? 0) > 0).map((c) => ({ label: c.label, value: sums.get(c.key)!, color: c.color }));
}

export function ResultsView() {
  const run = useStore((s) => s.run);
  const model = useStore((s) => s.model);
  const r = run.result;
  const [sel, setSel] = useState<string | null>(null);
  if (!r)
    return (
      <Empty title="No results yet">
        Run the simulation to see deadlines, latency distributions and utilization.
        <div className="mt-3">
          <button className="btn primary" onClick={() => void runSimulation()}>
            ▶ Run simulation
          </button>
        </div>
      </Empty>
    );
  const wps = r.workplans;
  const selected = wps.find((w) => w.id === sel) ?? wps.find((w) => w.missed + w.skipped > 0) ?? wps[0];
  const wpIndex = new Map((run.ranModel ?? model).workplans.map((w, i) => [w.id, i]));
  return (
    <div className="mx-auto max-w-[1280px] space-y-3 p-4">
      {run.ranModel !== model ? (
        <div className="flex items-center justify-between rounded-md bg-surface-2 px-3 py-2 text-[12.5px]">
          <span>The model has changed since this run.</span>
          <button className="btn sm primary" onClick={() => void runSimulation()}>
            Re-run
          </button>
        </div>
      ) : null}
      <Headline r={r} />
      {r.warnings.length ? (
        <div className="rounded-md border border-line bg-surface p-2 text-[12px]">
          {r.warnings.map((w) => (
            <div key={w} className="flex gap-2 py-0.5">
              <span className="text-warning">!</span>
              <span className="text-ink-2">{w}</span>
            </div>
          ))}
        </div>
      ) : null}
      <WorkplanTable r={r} selected={selected?.id ?? null} onSelect={setSel} wpIndex={wpIndex} />
      {selected ? <WorkplanDetail w={selected} color={seriesVar(wpIndex.get(selected.id) ?? 99)} /> : null}
      <ResourcesCard r={r} />
    </div>
  );
}

function Headline({ r }: { r: SimResult }) {
  const acts = r.workplans.reduce((a, w) => a + w.activations, 0);
  const fails = r.workplans.reduce((a, w) => a + w.missed + w.skipped, 0);
  let worst: { id: string; slack: number } | null = null;
  for (const w of r.workplans) {
    if (w.deadlinePs === null || !w.completed) continue;
    const slack = w.deadlinePs - w.response.max;
    if (!worst || slack < worst.slack) worst = { id: w.id, slack };
  }
  const links = r.resources.filter((x) => x.kind === 'bus' || x.kind === 'memory');
  const busiest = [...r.resources.filter((x) => x.kind === 'processor')].sort((a, b) => b.utilization - a.utilization)[0];
  const busiestLink = [...links].sort((a, b) => b.utilization - a.utilization)[0];
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Tile
        label="Deadline misses"
        value={fails.toLocaleString()}
        status={fails ? 'bad' : 'good'}
        sub={`${fails ? fmtPct(fails / Math.max(1, acts), 2) : 'none'} of ${acts.toLocaleString()} activations`}
      />
      <Tile
        label="Tightest deadline"
        value={worst ? fmtTime(worst.slack) : '—'}
        status={worst ? (worst.slack < 0 ? 'bad' : 'good') : undefined}
        sub={worst ? `slack of worst job, ${worst.id}` : 'no deadlines set'}
      />
      <Tile label="Busiest processor" value={busiest ? fmtPct(busiest.utilization) : '—'} sub={busiest ? `${busiest.name} average · peak ${fmtPct(busiest.peakWindowUtil)}` : ''} />
      <Tile
        label="Busiest link"
        value={busiestLink ? fmtPct(busiestLink.utilization) : '—'}
        sub={busiestLink ? `${busiestLink.name} · ${fmtRate(busiestLink.throughput)}` : ''}
      />
      <div className="col-span-full -mt-1 text-right text-[11.5px] text-muted">
        {fmtTime(r.durationPs)} simulated · {r.events.toLocaleString()} events in {fmtNum(r.wallMs / 1000, 2)} s · peak utilization uses a{' '}
        {fmtTime(r.utilWindowPs)} sliding window
      </div>
    </div>
  );
}

function WorkplanTable({ r, selected, onSelect, wpIndex }: { r: SimResult; selected: string | null; onSelect: (id: string) => void; wpIndex: Map<string, number> }) {
  return (
    <Card title="Workplans" pad={false}>
      <div className="overflow-x-auto">
        <table className="tbl">
          <thead>
            <tr>
              <th>Workplan</th>
              <th className="r">Jobs</th>
              <th className="r">Missed</th>
              <th className="r">Skipped</th>
              <th className="r">Mean</th>
              <th className="r">p99</th>
              <th className="r">Max</th>
              <th className="r">Deadline</th>
              <th className="r">Slack</th>
              <th className="r">End-to-end max</th>
            </tr>
          </thead>
          <tbody>
            {r.workplans.map((w) => {
              const slack = w.deadlinePs !== null && w.completed ? w.deadlinePs - w.response.max : null;
              return (
                <tr key={w.id} className={`hover ${selected === w.id ? 'sel' : ''}`} onClick={() => onSelect(w.id)}>
                  <td>
                    <span className="inline-flex items-center gap-2">
                      <Swatch color={seriesVar(wpIndex.get(w.id) ?? 99)} />
                      <span className="font-medium">{w.name}</span>
                    </span>
                  </td>
                  <td className="r">
                    {w.completed.toLocaleString()}
                    {w.incomplete ? <span className="text-muted"> +{w.incomplete}</span> : null}
                  </td>
                  <td className={`r ${w.missed ? 'font-semibold text-critical' : 'text-muted'}`}>{w.missed}</td>
                  <td className={`r ${w.skipped ? 'font-semibold text-critical' : 'text-muted'}`}>{w.skipped}</td>
                  <td className="r">{fmtTime(w.response.mean)}</td>
                  <td className="r">{fmtTime(w.response.p99)}</td>
                  <td className="r font-medium">{fmtTime(w.response.max)}</td>
                  <td className="r text-ink-2">{fmtTime(w.deadlinePs)}</td>
                  <td className="r">{slack === null ? '—' : <span className={slack < 0 ? 'font-semibold text-critical' : ''}>{fmtTime(slack)}</span>}</td>
                  <td className="r text-ink-2">
                    {w.e2eDeadlinePs !== null || w.e2e.max !== w.response.max ? fmtTime(w.e2e.max) : '—'}
                    {w.e2eMissed ? <span className="text-critical"> ({w.e2eMissed} late)</span> : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="border-t border-line px-3 py-2 text-[12px] text-muted">
        Response time runs from activation to the last step finishing. Jobs still running at the end are counted as missed once past their deadline. Click
        a row for details.
      </div>
    </Card>
  );
}

function WorkplanDetail({ w, color }: { w: WorkplanResult; color: string }) {
  const setView = useStore((s) => s.setView);
  const setFocusJob = useStore((s) => s.setFocusJob);
  const done = w.jobs.filter((j) => j.completion >= 0);
  const responses = done.map((j) => j.completion - j.activation);
  const refs = [
    ...(w.deadlinePs !== null ? [{ value: w.deadlinePs, label: 'deadline', color: 'var(--critical)' }] : []),
    ...(w.response.count > 20 ? [{ value: w.response.p99, label: 'p99', color: 'var(--ink-2)' }] : []),
  ];
  const mean = groupParts(w.breakdown);
  const worstParts = w.worst ? groupParts(Object.assign({}, ...w.worst.path.map((p) => p.parts))) : [];
  const scatter = useMemo(() => {
    // Thousands of SVG dots get slow; thin the met jobs evenly but always keep every miss.
    const stride = Math.max(1, Math.ceil(done.length / 2500));
    const kept = done.filter((j, i) => j.missed || i % stride === 0);
    return {
      name: 'response',
      color,
      dots: true,
      points: kept.map((j) => [j.activation, j.completion - j.activation] as [number, number]),
      pointColors: kept.map((j) => (j.missed ? 'var(--critical)' : color)),
    };
  }, [done, color]);

  return (
    <div className="grid gap-3 xl:grid-cols-2">
      <Card title={`${w.name} — response time distribution`}>
        <Histogram values={responses} format={fmtTime} refs={refs} color={color} />
        <div className="mt-1 grid grid-cols-4 gap-2 text-[12px]">
          {(['min', 'p50', 'p90', 'max'] as const).map((k) => (
            <div key={k}>
              <div className="text-muted">{k}</div>
              <div className="num font-medium">{fmtTime(w.response[k])}</div>
            </div>
          ))}
        </div>
      </Card>
      <Card title="Response time per job">
        <LineChart series={[scatter]} fx={fmtTime} fy={fmtTime} refs={w.deadlinePs !== null ? [{ value: w.deadlinePs, label: 'deadline' }] : []} xLabel="activation time" />
        <Legend
          items={[
            { name: 'met deadline', color },
            ...(w.missed ? [{ name: 'missed', color: 'var(--critical)' }] : []),
          ]}
        />
      </Card>
      <Card
        title="Where the time goes (critical path)"
        actions={
          w.worst ? (
            <button
              className="btn sm"
              onClick={() => {
                setFocusJob({ wp: w.id, job: w.worst!.job });
                setView('timeline');
              }}
            >
              Show worst job in timeline
            </button>
          ) : null
        }
        className="xl:col-span-2"
      >
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <div className="mb-1 text-[12px] text-ink-2">Average job · {fmtTime(mean.reduce((a, p) => a + p.value, 0))}</div>
            <StackedBar parts={mean} format={(v) => fmtTime(v)} />
          </div>
          <div>
            <div className="mb-1 text-[12px] text-ink-2">Worst job (#{w.worst?.job}) · {fmtTime(w.worst?.response)}</div>
            <StackedBar parts={worstParts} format={(v) => fmtTime(v)} />
          </div>
        </div>
        <div className="mt-2">
          <Legend items={CATEGORY.filter((c) => mean.some((m) => m.label === c.label) || worstParts.some((m) => m.label === c.label)).map((c) => ({ name: c.label, color: c.color }))} />
        </div>
        {w.worst ? (
          <div className="overflow-x-auto mt-3">
          <table className="tbl">
            <thead>
              <tr>
                <th>Worst job, step by step</th>
                <th>Resource</th>
                <th className="r">Ready</th>
                <th className="r">Start</th>
                <th className="r">End</th>
                <th>Time spent</th>
              </tr>
            </thead>
            <tbody>
              {w.worst.path.map((p) => (
                <tr key={p.step}>
                  <td className="font-mono">{p.step}</td>
                  <td className="text-ink-2">{p.resource || '—'}</td>
                  <td className="r">{fmtTime(p.readyT)}</td>
                  <td className="r">{fmtTime(p.startT)}</td>
                  <td className="r">{fmtTime(p.endT)}</td>
                  <td className="text-[12px] text-ink-2">
                    {Object.entries(p.parts)
                      .map(([k, v]) => `${k} ${fmtTime(v)}`)
                      .join(' · ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        ) : null}
      </Card>
      <Card title="Steps" pad={false} className="xl:col-span-2">
        <div className="overflow-x-auto">
        <table className="tbl">
          <thead>
            <tr>
              <th>Step</th>
              <th>Resource</th>
              <th className="r">Runs</th>
              <th className="r">Mean wait</th>
              <th className="r">Max wait</th>
              <th className="r">Mean duration</th>
              <th className="r">p99 duration</th>
              <th className="r">Max duration</th>
              <th className="r">Mean size</th>
              <th className="r">Step deadline misses</th>
            </tr>
          </thead>
          <tbody>
            {w.steps.map((s) => (
              <tr key={s.id}>
                <td className="font-mono">{s.id}</td>
                <td className="text-ink-2">{s.resource || '—'}</td>
                <td className="r">{s.count}</td>
                <td className="r">{fmtTime(s.wait.mean)}</td>
                <td className="r">{fmtTime(s.wait.max)}</td>
                <td className="r">{fmtTime(s.service.mean)}</td>
                <td className="r">{fmtTime(s.service.p99)}</td>
                <td className="r">{fmtTime(s.service.max)}</td>
                <td className="r">{s.kind === 'transfer' ? fmtBytes(s.meanBytes) : '—'}</td>
                <td className={`r ${s.deadlineMisses ? 'text-critical' : 'text-muted'}`}>{s.deadlineMisses}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </Card>
    </div>
  );
}

function Spark({ res, end }: { res: ResourceResult; end: number }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const h = 28;
  const pts = useMemo(() => bucketize(res.series.t, res.series.v, end, Math.max(20, Math.floor(w / 2))), [res, end, w]);
  const d = pts.map(([t, v], i) => `${i ? 'L' : 'M'}${((t / end) * w).toFixed(1)},${(h - Math.min(1, v) * (h - 2) - 1).toFixed(1)}`).join('');
  return (
    <div ref={ref} className="w-full">
      <svg width={w} height={h} className="block">
        <line x1={0} x2={w} y1={h - 0.5} y2={h - 0.5} stroke="var(--axis)" />
        <path d={`${d}L${w},${h}L0,${h}Z`} fill="var(--accent)" opacity={0.12} />
        <path d={d} fill="none" stroke="var(--accent)" strokeWidth={1.5} />
      </svg>
    </div>
  );
}

function ResourcesCard({ r }: { r: SimResult }) {
  const [focus, setFocus] = useState<string | null>(null);
  const focused = r.resources.find((x) => x.id === focus);
  return (
    <div className="grid gap-3 xl:grid-cols-[1fr_360px]">
      <Card title="Resources" pad={false}>
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>Resource</th>
                <th>Average utilization</th>
                <th className="r">Peak window</th>
                <th className="w-[34%]">Over time</th>
                <th className="r">Throughput / queue</th>
              </tr>
            </thead>
            <tbody>
              {r.resources.map((x) => (
                <tr key={x.id} className={`hover ${focus === x.id ? 'sel' : ''}`} onClick={() => setFocus(focus === x.id ? null : x.id)}>
                  <td>
                    <div className="font-medium">{x.name}</div>
                    <div className="text-[11px] text-muted">
                      {x.kind} · {x.kind === 'processor' ? `${x.capacity} core${x.capacity > 1 ? 's' : ''}` : x.kind === 'dma' ? `${x.capacity} ch` : fmtRate(x.capacity)}
                    </div>
                  </td>
                  <td>
                    <UtilBar value={x.utilization} width={100} />
                  </td>
                  <td className="r">{fmtPct(x.peakWindowUtil)}</td>
                  <td>
                    <Spark res={x} end={r.durationPs} />
                  </td>
                  <td className="r text-ink-2">
                    {x.kind === 'bus' || x.kind === 'memory'
                      ? fmtRate(x.throughput)
                      : x.queue
                        ? `queue avg ${fmtNum(x.queue.mean, 2)}, max ${x.queue.max}`
                        : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <div className="space-y-3">
        <Card title={focused ? `${focused.name} over time` : 'Utilization over time'}>
          {focused ? (
            <LineChart
              series={[{ name: 'utilization', color: 'var(--accent)', points: bucketize(focused.series.t, focused.series.v, r.durationPs, 300) }]}
              fx={fmtTime}
              fy={(v) => fmtPct(v, 0)}
              yMin={0}
              yMax={1}
              step
              height={180}
            />
          ) : (
            <div className="py-4 text-center text-muted">Select a resource to plot it.</div>
          )}
        </Card>
        <Card title="Buffer footprint" pad={false}>
          <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>Memory</th>
                <th className="r">Peak</th>
                <th>of capacity</th>
              </tr>
            </thead>
            <tbody>
              {r.footprints.map((f) => (
                <tr key={f.id}>
                  <td>{f.name}</td>
                  <td className="r">{fmtBytes(f.peak)}</td>
                  <td>
                    {f.peak > f.size ? <Status ok={false} text={`${fmtPct(f.peak / f.size, 0)} — over`} /> : <UtilBar value={f.peak / f.size} width={80} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
          <div className="border-t border-line px-3 py-2 text-[11.5px] text-muted">
            Data written into a memory is held from the start of the write until every step that consumes it has finished.
          </div>
        </Card>
      </div>
    </div>
  );
}
