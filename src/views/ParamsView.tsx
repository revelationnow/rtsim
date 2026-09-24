import { useMemo } from 'react';
import { math } from '../model/expr';
import type { Model } from '../model/types';
import { Card, ExprField, Field, Select } from '../ui/components';
import { useParamScope } from '../ui/hooks';
import { useStore } from '../ui/store';

function display(v: unknown): string {
  if (v === undefined) return '';
  if (typeof v === 'number') return String(+v.toPrecision(6));
  try {
    return math.format(v as never, { precision: 5 });
  } catch {
    return String(v);
  }
}

/** Counts textual references to a parameter anywhere in the model. */
function usage(model: Model, name: string): number {
  const re = new RegExp(`(^|[^A-Za-z0-9_])${name}([^A-Za-z0-9_]|$)`);
  let n = 0;
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      if (re.test(v)) n++;
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  const { params, ...rest } = model;
  walk(rest);
  walk(Object.entries(params ?? {}).filter(([k]) => k !== name).map(([, v]) => v));
  return n;
}

export function ParamsView() {
  const model = useStore((s) => s.model);
  const update = useStore((s) => s.update);
  const scope = useParamScope();
  const params = Object.entries(model.params ?? {});
  const uses = useMemo(() => Object.fromEntries(params.map(([k]) => [k, usage(model, k)])), [model, params]);

  const rename = (from: string, to: string) =>
    update((m) => {
      if (!/^[A-Za-z_]\w*$/.test(to) || to === from || (m.params && to in m.params)) return;
      m.params = Object.fromEntries(Object.entries(m.params ?? {}).map(([k, v]) => [k === from ? to : k, v]));
      // Rewrite references so the model keeps meaning the same thing.
      const re = new RegExp(`(^|[^A-Za-z0-9_.])${from}(?=[^A-Za-z0-9_]|$)`, 'g');
      const fix = (v: unknown): unknown => {
        if (typeof v === 'string') return v.replace(re, `$1${to}`);
        if (Array.isArray(v)) return v.map(fix);
        if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === 'id' || k === 'name' ? x : fix(x)]));
        return v;
      };
      m.processors = fix(m.processors) as Model['processors'];
      m.memories = fix(m.memories) as Model['memories'];
      m.buses = fix(m.buses) as Model['buses'];
      m.dmas = fix(m.dmas) as Model['dmas'];
      m.workplans = fix(m.workplans) as Model['workplans'];
      m.params = fix(m.params) as Model['params'];
      m.sim = fix(m.sim) as Model['sim'];
    });

  return (
    <div className="mx-auto max-w-[1000px] space-y-3 p-4">
      <Card
        title="Parameters"
        actions={
          <button
            className="btn sm"
            onClick={() =>
              update((m) => {
                m.params ??= {};
                let n = 'p';
                for (let i = 2; n in m.params; i++) n = `p${i}`;
                m.params[n] = 1;
              })
            }
          >
            + Parameter
          </button>
        }
      >
        <p className="mb-3 text-ink-2">
          Named values usable in any expression, e.g. <code>ddr_bw = 12.8 GB/s</code> then a memory bandwidth of <code>ddr_bw</code>. Parameters may refer
          to earlier ones. Sweeps and the solver vary one parameter at a time, so put the knobs you want to scope here.
        </p>
        <div className="overflow-x-auto">
        <table className="tbl">
          <thead>
            <tr>
              <th className="w-[180px]">Name</th>
              <th>Expression</th>
              <th className="w-[160px]">Value</th>
              <th className="r w-[70px]">Uses</th>
              <th className="w-[36px]" />
            </tr>
          </thead>
          <tbody>
            {params.map(([k, v]) => (
              <tr key={k}>
                <td className="align-top">
                  <input
                    className="ctl font-mono text-[12px]"
                    defaultValue={k}
                    spellCheck={false}
                    onBlur={(e) => {
                      const to = e.target.value.trim();
                      if (to !== k) rename(k, to);
                      e.target.value = k;
                    }}
                    onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                  />
                </td>
                <td className="align-top">
                  <ExprField value={v} kind="none" scope={scope} onChange={(nv) => update((m) => void (m.params![k] = nv ?? ''), `param.${k}`)} />
                </td>
                <td className="num align-top pt-2 text-ink-2">{k in scope ? display(scope[k]) : <span className="text-critical">error</span>}</td>
                <td className="r align-top pt-2 text-ink-2">{uses[k]}</td>
                <td className="align-top">
                  <button className="btn sm ghost" onClick={() => update((m) => void delete m.params![k])} title="Remove">
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </Card>

      <Card title="Simulation settings">
        <div className="grid max-w-[640px] gap-x-6">
          <Field label="Duration" hint="Simulated time">
            <ExprField value={model.sim.duration} kind="time" scope={scope} onChange={(v) => update((m) => void (m.sim.duration = v ?? ''), 'sim.duration')} />
          </Field>
          <Field label="Seed" hint="Same seed + same model = identical run. Each workplan has its own random stream.">
            <input className="ctl num" type="number" value={model.sim.seed ?? 1} onChange={(e) => update((m) => void (m.sim.seed = Number(e.target.value) || 0), 'sim.seed')} />
          </Field>
          <Field label="Link arbitration" hint="How contending transfers share a bus or memory">
            <Select
              value={model.sim.arbitration ?? 'priority'}
              options={[
                { value: 'priority', label: 'Priority classes, fair within a class (QoS)' },
                { value: 'fair', label: 'Fair share by weight, priorities ignored' },
              ]}
              onChange={(v) => update((m) => void (m.sim.arbitration = v))}
            />
          </Field>
          <Field label="Peak window" hint="Window for peak (sliding-average) utilization; default duration / 100">
            <ExprField
              value={model.sim.utilWindow}
              kind="time"
              scope={scope}
              optional
              placeholder="duration / 100"
              onChange={(v) =>
                update((m) => {
                  if (v === undefined || v === '') delete m.sim.utilWindow;
                  else m.sim.utilWindow = v;
                }, 'sim.utilWindow')
              }
            />
          </Field>
          <Field label="Timeline limit" hint="Segments recorded for the timeline; statistics are always complete">
            <input
              className="ctl num"
              type="number"
              value={model.sim.traceLimit ?? 200000}
              onChange={(e) => update((m) => void (m.sim.traceLimit = Math.max(0, Number(e.target.value) || 0)), 'sim.trace')}
            />
          </Field>
        </div>
      </Card>
    </div>
  );
}
