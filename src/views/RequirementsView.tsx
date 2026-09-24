import { Fragment, useMemo, useState } from 'react';
import { analyze, type Demand } from '../sim/analysis';
import { Legend, StackedBar } from '../ui/charts';
import { Card, Empty, Status, UtilBar } from '../ui/components';
import { fmtHz, fmtNum, fmtRate, fmtTime } from '../ui/format';
import { seriesVar, useCompiled } from '../ui/hooks';
import { useStore } from '../ui/store';

function capText(d: Demand, v: number): string {
  if (d.kind === 'processor') return `${fmtNum(v, 3)} core${v === 1 ? '' : 's'}`;
  if (d.kind === 'dma') return `${fmtNum(v, 3)} ch`;
  return fmtRate(v);
}

export function RequirementsView() {
  const c = useCompiled();
  const model = useStore((s) => s.model);
  const run = useStore((s) => s.run);
  const [target, setTarget] = useState(0.7);
  const [open, setOpen] = useState<string | null>(null);
  const a = useMemo(() => (c.ok ? analyze(c.model) : null), [c]);
  if (!c.ok || !a) return <Empty title="Fix the model errors first">The requirements analysis needs a valid model. See the issues panel at the bottom left.</Empty>;

  const wpIndex = new Map(model.workplans.map((w, i) => [w.id, i]));
  const simUtil = new Map((run.ranModel === model ? run.result?.resources : undefined)?.map((r) => [r.id, r]) ?? []);

  return (
    <div className="mx-auto max-w-[1200px] space-y-3 p-4">
      <div className="rounded-lg border border-line bg-surface p-3 text-ink-2">
        <b className="text-ink">Expected-value analysis, no contention.</b> Every random quantity is replaced by its mean and each workplan runs at its
        long-run activation rate. This is the load the hardware must sustain on average — a necessary condition. Queueing, bursts and jitter come on top:
        run the simulation to see them, and use <i>Sweep &amp; solve</i> to find the capacity that meets every deadline.
      </div>
      {a.errors.length ? (
        <div className="rounded-md bg-critical-wash p-2 text-[12px]">
          {a.errors.map((e) => (
            <div key={e}>{e}</div>
          ))}
        </div>
      ) : null}

      <Card
        title="Resource demand vs capacity"
        actions={
          <label className="flex flex-wrap items-center gap-2 text-[12px] text-ink-2">
            Target max utilization
            <input type="range" min={0.3} max={1} step={0.05} value={target} onChange={(e) => setTarget(Number(e.target.value))} />
            <span className="num w-[36px]">{Math.round(target * 100)}%</span>
          </label>
        }
        pad={false}
      >
        <div className="overflow-x-auto">
        <table className="tbl min-w-[760px]">
          <thead>
            <tr>
              <th>Resource</th>
              <th className="r">Capacity</th>
              <th className="r">Mean demand</th>
              <th>Utilization</th>
              <th className="r" title="Capacity needed to keep utilization at or below the target">
                Needed at {Math.round(target * 100)}%
              </th>
              <th>Status</th>
              <th className="r">Simulated</th>
            </tr>
          </thead>
          <tbody>
            {a.demand.map((d) => {
              const need = d.demand / target;
              const ok = d.utilization <= target ? true : d.utilization <= 1 ? 'warn' : false;
              const sim = simUtil.get(d.id);
              return (
                <Fragment key={d.id}>
                  <tr className="hover" onClick={() => setOpen(open === d.id ? null : d.id)}>
                    <td>
                      <span className="mr-1 text-muted">{open === d.id ? '▾' : '▸'}</span>
                      <span className="font-medium">{d.name}</span> <span className="text-[11px] text-muted">{d.kind}</span>
                    </td>
                    <td className="r">{capText(d, d.capacity)}</td>
                    <td className="r">{capText(d, d.demand)}</td>
                    <td>
                      <UtilBar value={d.utilization} />
                    </td>
                    <td className="r font-medium">{capText(d, need)}</td>
                    <td>
                      <Status ok={ok} text={ok === true ? 'within target' : ok === 'warn' ? 'above target' : 'overloaded'} />
                    </td>
                    <td className="r text-ink-2">{sim ? `${(sim.utilization * 100).toFixed(1)}% · peak ${(sim.peakWindowUtil * 100).toFixed(0)}%` : '—'}</td>
                  </tr>
                  {open === d.id ? (
                    <tr>
                      <td colSpan={7} className="bg-surface-2">
                        {d.byWorkplan.length ? (
                          <div className="space-y-2 py-1">
                            <StackedBar
                              parts={d.byWorkplan.map((x) => ({ label: x.id, value: x.value, color: seriesVar(wpIndex.get(x.id) ?? 99) }))}
                              format={(v) => capText(d, v)}
                            />
                            <Legend items={d.byWorkplan.map((x) => ({ name: `${x.id} ${capText(d, x.value)}`, color: seriesVar(wpIndex.get(x.id) ?? 99) }))} />
                          </div>
                        ) : (
                          <span className="text-muted">No workplan uses this resource.</span>
                        )}
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        </div>
        <div className="border-t border-line px-3 py-2 text-[12px] text-muted">
          Bus and memory demand counts every byte each resource carries: a copy through a DMA on a shared bus crosses it twice. Click a row for the
          per-workplan split.
        </div>
      </Card>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card title="Latency lower bound vs deadline" pad={false}>
          <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>Workplan</th>
                <th className="r">Lower bound</th>
                <th className="r">Deadline</th>
                <th className="r">Slack</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {a.bounds.map((b) => {
                const slack = b.deadlinePs === null ? null : b.deadlinePs - b.lowerBoundPs;
                return (
                  <tr key={b.id} title={b.path.map((p) => `${p.step} ${fmtTime(p.ps)}`).join(' → ')}>
                    <td>
                      <div className="font-medium">{b.id}</div>
                      <div className="max-w-[300px] truncate text-[11px] text-muted">{b.path.map((p) => p.step).join(' → ')}</div>
                    </td>
                    <td className="r">{fmtTime(b.lowerBoundPs)}</td>
                    <td className="r">{fmtTime(b.deadlinePs)}</td>
                    <td className="r">{slack === null ? '—' : fmtTime(slack)}</td>
                    <td>
                      {slack === null ? (
                        <span className="text-muted">no deadline</span>
                      ) : (
                        <Status ok={slack < 0 ? false : slack < 0.2 * b.deadlinePs! ? 'warn' : true} text={slack < 0 ? 'infeasible' : slack < 0.2 * b.deadlinePs! ? 'tight' : 'ok'} />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
          <div className="border-t border-line px-3 py-2 text-[12px] text-muted">
            Longest dependency chain with each step alone on its resource. A negative slack means no amount of scheduling can meet the deadline.
          </div>
        </Card>

        <Card title="Activation rates" pad={false}>
          <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>Workplan</th>
                <th className="r">Rate</th>
                <th>Derived from</th>
              </tr>
            </thead>
            <tbody>
              {a.rates.map((r) => (
                <tr key={r.id}>
                  <td className="font-medium">{r.id}</td>
                  <td className="r">{r.hz === null ? '—' : fmtHz(r.hz)}</td>
                  <td className="text-ink-2">{r.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </Card>
      </div>
    </div>
  );
}
