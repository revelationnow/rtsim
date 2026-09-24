import dagre from '@dagrejs/dagre';
import { Background, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider, useReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react';
import { useEffect, useMemo } from 'react';
import { newStep, newWorkplan, removeStep, removeWorkplan, renameStep, renameWorkplan } from '../model/edit';
import type { Expr, StepSpec, TriggerSpec, WorkplanSpec } from '../model/types';
import { Card, Empty, ExprField, Field, IdField, Select, Swatch, TextField } from '../ui/components';
import { fmtTime } from '../ui/format';
import { seriesVar, useCompiled, useParamScope, useStepScope } from '../ui/hooks';
import { useStore } from '../ui/store';

export function triggerSummary(t: TriggerSpec): string {
  const rep = t.repeat && t.repeat !== 1 ? ` ×${t.repeat}` : '';
  switch (t.type) {
    case 'periodic':
      return `every ${t.period}${t.jitter ? ' ± jitter' : ''}${rep}`;
    case 'poisson':
      return `random, mean ${t.interval}${rep}`;
    case 'event':
      return `on ${t.mode === 'all' ? 'all of ' : ''}${t.sources.join(', ') || '?'}${t.every && t.every > 1 ? ` /${t.every}` : ''}${rep}`;
    case 'times':
      return `at ${t.times.length} time${t.times.length === 1 ? '' : 's'}${rep}`;
  }
}

export function WorkplansView() {
  const model = useStore((s) => s.model);
  const selectedWp = useStore((s) => s.selectedWp);
  const selectWp = useStore((s) => s.selectWp);
  const update = useStore((s) => s.update);
  const wp = model.workplans.find((w) => w.id === selectedWp) ?? model.workplans[0];

  return (
    <div className="flex h-full min-h-0">
      <aside className="w-[250px] shrink-0 overflow-auto border-r border-line bg-surface p-2">
        <div className="flex items-center justify-between px-1 pb-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">Workplans</span>
          <button
            className="btn sm"
            onClick={() => {
              let id = '';
              update((m) => void (id = newWorkplan(m)));
              selectWp(id);
            }}
          >
            + New
          </button>
        </div>
        {model.workplans.map((w, i) => (
          <button
            key={w.id}
            onClick={() => selectWp(w.id)}
            className={`mb-0.5 flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left ${w.id === wp?.id ? 'bg-accent-wash' : 'hover:bg-surface-2'}`}
          >
            <span className="mt-[3px]">
              <Swatch color={seriesVar(i)} />
            </span>
            <span className="min-w-0">
              <span className="block truncate font-medium">{w.name || w.id}</span>
              <span className="block truncate text-[11.5px] text-muted">{triggerSummary(w.trigger)}</span>
            </span>
          </button>
        ))}
      </aside>
      <div className="min-w-0 flex-1 overflow-auto p-4">
        {wp ? <WorkplanEditor key={wp.id} wp={wp} index={model.workplans.indexOf(wp)} /> : <Empty title="No workplans yet">A workplan is a task graph started by a trigger. Add one to begin.</Empty>}
      </div>
    </div>
  );
}

function WorkplanEditor({ wp, index }: { wp: WorkplanSpec; index: number }) {
  const model = useStore((s) => s.model);
  const update = useStore((s) => s.update);
  const selectWp = useStore((s) => s.selectWp);
  const scope = useParamScope();
  const run = useStore((s) => s.run);
  const res = run.result?.workplans.find((w) => w.id === wp.id);

  const edit = (fn: (w: WorkplanSpec) => void, key?: string) =>
    update((m) => {
      const w = m.workplans.find((x) => x.id === wp.id);
      if (w) fn(w);
    }, key && `${wp.id}.${key}`);
  const setOpt = <K extends keyof WorkplanSpec>(k: K, v: WorkplanSpec[K] | undefined) =>
    edit((w) => {
      if (v === undefined || v === '') delete w[k];
      else w[k] = v;
    }, String(k));

  return (
    <div className="mx-auto max-w-[1180px] space-y-3">
      <div className="flex items-center gap-2">
        <Swatch color={seriesVar(index)} />
        <h2 className="text-[16px] font-semibold">{wp.name || wp.id}</h2>
        {res ? (
          <span className="ml-2 text-[12px] text-ink-2">
            last run: {res.completed} jobs · p99 {fmtTime(res.response.p99)} · max {fmtTime(res.response.max)} ·{' '}
            <span className={res.missed + res.skipped ? 'font-semibold text-critical' : 'text-good-ink'}>
              {res.missed} missed{res.skipped ? `, ${res.skipped} skipped` : ''}
            </span>
          </span>
        ) : null}
        <div className="flex-1" />
        <button
          className="btn sm"
          onClick={() => {
            if (!confirm(`Delete workplan "${wp.id}"?`)) return;
            update((m) => removeWorkplan(m, wp.id));
            selectWp(null);
          }}
        >
          Delete workplan
        </button>
      </div>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
        <Card title="Workplan">
          <Field label="Id">
            <IdField
              value={wp.id}
              taken={model.workplans.map((w) => w.id)}
              onCommit={(v) => {
                update((m) => renameWorkplan(m, wp.id, v));
                selectWp(v);
              }}
            />
          </Field>
          <Field label="Name">
            <TextField value={wp.name ?? ''} placeholder={wp.id} onChange={(v) => setOpt('name', v)} />
          </Field>
          <Field label="Priority" hint="Default for every step: CPU scheduling, DMA queueing and link QoS. Higher wins.">
            <input className="ctl num" type="number" value={wp.priority ?? 0} onChange={(e) => setOpt('priority', Number(e.target.value))} />
          </Field>
          <Field label="Deadline" hint="Response time budget from activation to the last step finishing">
            <ExprField value={wp.deadline} kind="time" scope={scope} optional placeholder="none" onChange={(v) => setOpt('deadline', v)} />
          </Field>
          <Field label="End-to-end" hint="Budget from the origin of the trigger chain (the first activation that led here)">
            <ExprField value={wp.e2eDeadline} kind="time" scope={scope} optional placeholder="none" onChange={(v) => setOpt('e2eDeadline', v)} />
          </Field>
          <Field label="Max in flight" hint="Jobs allowed to overlap; empty = unlimited">
            <ExprField value={wp.maxInFlight} kind="count" scope={scope} optional placeholder="unlimited" onChange={(v) => setOpt('maxInFlight', v)} />
          </Field>
          {wp.maxInFlight !== undefined ? (
            <Field label="On overrun">
              <Select
                value={wp.onOverrun ?? 'skip'}
                options={[
                  { value: 'skip', label: 'Skip the activation (frame drop)' },
                  { value: 'queue', label: 'Queue it until a slot frees' },
                ]}
                onChange={(v) => setOpt('onOverrun', v)}
              />
            </Field>
          ) : null}
        </Card>

        <TriggerCard wp={wp} edit={edit} />

        <Card
          title="Per-job variables"
          actions={
            <button
              className="btn sm"
              onClick={() =>
                edit((w) => {
                  w.vars ??= {};
                  let n = 'n';
                  for (let i = 2; n in w.vars; i++) n = `n${i}`;
                  w.vars[n] = 'uniform(1, 10)';
                })
              }
            >
              + Variable
            </button>
          }
        >
          <p className="mb-2 text-[12px] text-ink-2">
            Drawn once per job, in order, and shared by every step — keep data-dependent sizes and work consistent within a job.
          </p>
          <VarsEditor wp={wp} edit={edit} />
        </Card>
      </div>

      <StepsEditor wp={wp} edit={edit} />
    </div>
  );
}

function TriggerCard({ wp, edit }: { wp: WorkplanSpec; edit: (fn: (w: WorkplanSpec) => void, key?: string) => void }) {
  const model = useStore((s) => s.model);
  const scope = useParamScope();
  const t = wp.trigger;
  const setT = (patch: Partial<TriggerSpec> & Record<string, unknown>, key = 'trigger') =>
    edit((w) => {
      const tt = w.trigger as unknown as Record<string, unknown>;
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined || v === '') delete tt[k];
        else tt[k] = v;
      }
    }, key);
  const changeType = (type: TriggerSpec['type']) =>
    edit((w) => {
      const prev = w.trigger;
      w.trigger =
        type === 'periodic'
          ? { type, period: prev.type === 'periodic' ? prev.period : '10 ms' }
          : type === 'poisson'
            ? { type, interval: '10 ms' }
            : type === 'event'
              ? { type, sources: model.workplans.filter((x) => x.id !== w.id).slice(0, 1).map((x) => x.id) }
              : { type, times: ['0 ms'] };
    });

  const sourceOptions = model.workplans.filter((w) => w.id !== wp.id).flatMap((w) => [w.id, ...w.steps.map((s) => `${w.id}.${s.id}`)]);

  return (
    <Card title="Trigger">
      <Field label="Type">
        <Select
          value={t.type}
          options={[
            { value: 'periodic', label: 'Periodic timer' },
            { value: 'poisson', label: 'Random arrivals (Poisson)' },
            { value: 'event', label: 'Completion of other work' },
            { value: 'times', label: 'Fixed times' },
          ]}
          onChange={changeType}
        />
      </Field>
      {t.type === 'periodic' && (
        <>
          <Field label="Period">
            <ExprField value={t.period} kind="time" scope={scope} onChange={(v) => setT({ period: v as Expr }, 'trigger.period')} />
          </Field>
          <Field label="Offset" hint="Phase of the first activation">
            <ExprField value={t.offset} kind="time" scope={scope} optional placeholder="0" onChange={(v) => setT({ offset: v }, 'trigger.offset')} />
          </Field>
          <Field label="Release jitter" hint="Delay from activation to release, drawn per job, e.g. uniform(0, 50 us). Response is measured from activation.">
            <ExprField value={t.jitter} kind="time" scope={scope} optional placeholder="none" onChange={(v) => setT({ jitter: v }, 'trigger.jitter')} />
          </Field>
        </>
      )}
      {t.type === 'poisson' && (
        <>
          <Field label="Mean interval" hint="Mean time between arrivals">
            <ExprField value={t.interval} kind="time" scope={scope} onChange={(v) => setT({ interval: v as Expr }, 'trigger.interval')} />
          </Field>
          <Field label="Min interval">
            <ExprField value={t.minInterval} kind="time" scope={scope} optional placeholder="0" onChange={(v) => setT({ minInterval: v }, 'trigger.min')} />
          </Field>
        </>
      )}
      {t.type === 'poisson' ? (
        <p className="mb-1 text-[11.5px] text-muted">Gaps are exponentially distributed with this mean (a Poisson process), never shorter than the minimum.</p>
      ) : null}
      {t.type === 'event' && (
        <>
          <Field label="Sources" hint="A workplan (fires when a job completes) or workplan.step">
            <div className="flex flex-wrap items-center gap-1">
              {t.sources.map((s) => (
                <span key={s} className="inline-flex items-center gap-1 rounded-md border border-line bg-surface-2 py-0.5 pl-2 pr-1 font-mono text-[12px]">
                  {s}
                  <button className="px-1 text-muted hover:text-critical" onClick={() => setT({ sources: t.sources.filter((x) => x !== s) })}>
                    ×
                  </button>
                </span>
              ))}
              <select className="ctl !w-auto" value="" onChange={(e) => e.target.value && setT({ sources: [...t.sources, e.target.value] })}>
                <option value="">+ source</option>
                {sourceOptions
                  .filter((o) => !t.sources.includes(o))
                  .map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
              </select>
            </div>
          </Field>
          <Field label="Fire when">
            <Select
              value={t.mode ?? 'any'}
              options={[
                { value: 'any', label: 'any source completes' },
                { value: 'all', label: 'all sources have completed (join)' },
              ]}
              onChange={(v) => setT({ mode: v })}
            />
          </Field>
          <Field label="Tokens" hint="How completions queue up between firings">
            <Select
              value={t.consume ?? 'fifo'}
              options={[
                { value: 'fifo', label: 'FIFO — process every completion' },
                { value: 'latest', label: 'Latest — sample newest, drop stale' },
              ]}
              onChange={(v) => setT({ consume: v })}
            />
          </Field>
          <Field label="Every n" hint="Completions needed per firing (rate division)">
            <input className="ctl num" type="number" min={1} value={t.every ?? 1} onChange={(e) => setT({ every: Math.max(1, Number(e.target.value) || 1) }, 'trigger.every')} />
          </Field>
          <Field label="Delay" hint="Latency between the source completing and this activation (e.g. interrupt latency)">
            <ExprField value={t.delay} kind="time" scope={scope} optional placeholder="0" onChange={(v) => setT({ delay: v }, 'trigger.delay')} />
          </Field>
        </>
      )}
      {t.type === 'times' && (
        <Field label="Times" hint="Comma-separated activation times">
          <TextField
            mono
            value={t.times.join(', ')}
            onChange={(v) =>
              setT(
                {
                  times: v
                    .split(',')
                    .map((x) => x.trim())
                    .filter(Boolean),
                },
                'trigger.times',
              )
            }
          />
        </Field>
      )}
      {t.type !== 'times' && t.type !== 'event' ? (
        <Field label="Max activations">
          <input
            className="ctl num"
            type="number"
            min={0}
            placeholder="unlimited"
            value={t.count ?? ''}
            onChange={(e) => setT({ count: e.target.value === '' ? undefined : Math.max(0, Number(e.target.value)) }, 'trigger.count')}
          />
        </Field>
      ) : null}
      <Field label="Jobs per firing" hint="Fan one firing out into several jobs, e.g. one per tile">
        <ExprField value={t.repeat} kind="count" scope={scope} optional placeholder="1" onChange={(v) => setT({ repeat: v }, 'trigger.repeat')} />
      </Field>
    </Card>
  );
}

function VarsEditor({ wp, edit }: { wp: WorkplanSpec; edit: (fn: (w: WorkplanSpec) => void, key?: string) => void }) {
  const scope = useStepScope(wp.id);
  const vars = Object.entries(wp.vars ?? {});
  if (!vars.length) return <div className="text-muted">None. Example: objects = round(clamp(normal(12, 5), 0, 64))</div>;
  return (
    <div className="space-y-1.5">
      {vars.map(([name, e]) => (
        <div key={name} className="grid grid-cols-[90px_1fr_auto] items-start gap-1.5">
          <input
            className="ctl font-mono text-[12px]"
            defaultValue={name}
            onBlur={(ev) => {
              const nn = ev.target.value.trim();
              if (!nn || nn === name || !/^[A-Za-z_]\w*$/.test(nn)) {
                ev.target.value = name;
                return;
              }
              edit((w) => {
                const entries = Object.entries(w.vars ?? {}).map(([k, v]) => [k === name ? nn : k, v] as const);
                w.vars = Object.fromEntries(entries);
              });
            }}
          />
          <ExprField value={e} kind="none" scope={scope} onChange={(v) => edit((w) => void (w.vars![name] = v ?? ''), `var.${name}`)} />
          <button
            className="btn sm ghost"
            title="Remove"
            onClick={() =>
              edit((w) => {
                delete w.vars![name];
                if (!Object.keys(w.vars!).length) delete w.vars;
              })
            }
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Steps: dependency graph + table
// ---------------------------------------------------------------------------

interface StepNodeData extends Record<string, unknown> {
  step: StepSpec;
  line: string;
  stats?: string;
  error: boolean;
}

function StepNode({ data, selected }: NodeProps<Node<StepNodeData>>) {
  const k = data.step.kind;
  const tag = k === 'compute' ? 'COMPUTE' : k === 'transfer' ? 'TRANSFER' : 'DELAY';
  return (
    <div
      className={`w-[190px] border bg-surface px-2.5 py-1.5 ${k === 'transfer' ? 'rounded-full px-4' : k === 'delay' ? 'rounded-md border-dashed' : 'rounded-md'} ${
        data.error ? 'border-critical' : selected ? 'border-accent ring-2 ring-[var(--accent-wash)]' : 'border-line-strong'
      }`}
    >
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />
      <div className="flex items-baseline justify-between gap-1">
        <span className="truncate font-mono text-[12px] font-semibold">{data.step.id}</span>
        <span className="text-[9.5px] tracking-wide text-muted">{tag}</span>
      </div>
      <div className="truncate text-[11px] text-ink-2">{data.line}</div>
      {data.stats ? <div className="truncate text-[10.5px] text-muted">{data.stats}</div> : null}
    </div>
  );
}

const stepNodeTypes = { step: StepNode };

function stepLine(s: StepSpec): string {
  if (s.kind === 'compute') return `${s.on} · ${s.cycles}`;
  if (s.kind === 'transfer') return `${s.from} → ${s.to}${s.via ? ` via ${s.via}` : ''} · ${s.bytes}`;
  return `wait ${s.time}`;
}

function StepGraph({ wp, edit }: { wp: WorkplanSpec; edit: (fn: (w: WorkplanSpec) => void, key?: string) => void }) {
  const flow = useReactFlow();
  const c = useCompiled();
  const run = useStore((s) => s.run);
  const res = run.result?.workplans.find((w) => w.id === wp.id);
  const errorSteps = useMemo(() => new Set(c.issues.filter((i) => i.severity === 'error' && i.path.startsWith(`workplans.${wp.id}.steps.`)).map((i) => i.path.split('.')[3])), [c.issues, wp.id]);

  const { nodes, edges } = useMemo(() => {
    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: 'LR', nodesep: 18, ranksep: 46, marginx: 10, marginy: 10 });
    g.setDefaultEdgeLabel(() => ({}));
    for (const s of wp.steps) g.setNode(s.id, { width: 190, height: 58 });
    for (const s of wp.steps) for (const a of s.after ?? []) if (g.hasNode(a)) g.setEdge(a, s.id);
    dagre.layout(g);
    const nodes: Node<StepNodeData>[] = wp.steps.map((s) => {
      const n = g.node(s.id);
      const st = res?.steps.find((x) => x.id === s.id);
      return {
        id: s.id,
        type: 'step',
        position: { x: n.x - 95, y: n.y - 29 },
        data: { step: s, line: stepLine(s), error: errorSteps.has(s.id), stats: st?.count ? `mean ${fmtTime(st.service.mean)} · wait ${fmtTime(st.wait.mean)}` : undefined },
      };
    });
    const worst = new Set((res?.worst?.path ?? []).map((p) => p.step));
    const edges: Edge[] = wp.steps.flatMap((s) =>
      (s.after ?? []).map((a) => {
        const crit = worst.has(a) && worst.has(s.id);
        return {
          id: `${a}->${s.id}`,
          source: a,
          target: s.id,
          markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: crit ? 'var(--critical)' : 'var(--axis)' },
          style: { strokeWidth: 2, stroke: crit ? 'var(--critical)' : undefined },
        };
      }),
    );
    return { nodes, edges };
  }, [wp.steps, res, errorSteps]);

  useEffect(() => {
    const t = setTimeout(() => flow.fitView({ padding: 0.12, maxZoom: 1.1 }), 30);
    return () => clearTimeout(t);
  }, [wp.id, wp.steps.length, flow]);

  return (
    <div className="h-[280px] overflow-hidden rounded-md border border-line">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={stepNodeTypes}
        fitView
        nodesDraggable={false}
        proOptions={{ hideAttribution: true }}
        minZoom={0.3}
        onConnect={(conn) => {
          if (!conn.source || !conn.target || conn.source === conn.target) return;
          edit((w) => {
            const s = w.steps.find((x) => x.id === conn.target);
            if (s && !(s.after ?? []).includes(conn.source!)) s.after = [...(s.after ?? []), conn.source!];
          });
        }}
        onEdgesChange={(changes) => {
          for (const ch of changes)
            if (ch.type === 'remove') {
              const [a, b] = ch.id.split('->');
              edit((w) => {
                const s = w.steps.find((x) => x.id === b);
                if (s?.after) {
                  s.after = s.after.filter((x) => x !== a);
                  if (!s.after.length) delete s.after;
                }
              });
            }
        }}
        deleteKeyCode={['Backspace', 'Delete']}
      >
        <Background gap={20} size={1} />
      </ReactFlow>
    </div>
  );
}

function StepsEditor({ wp, edit }: { wp: WorkplanSpec; edit: (fn: (w: WorkplanSpec) => void, key?: string) => void }) {
  const model = useStore((s) => s.model);
  const update = useStore((s) => s.update);
  const scope = useStepScope(wp.id);
  const procs = model.processors.map((p) => p.id);
  const endpoints = [...model.memories.map((m) => m.id), ...procs];
  const masters = [...(model.dmas ?? []).map((d) => d.id), ...procs];

  const setStep = (id: string, fn: (s: StepSpec) => void, key?: string) =>
    edit((w) => {
      const s = w.steps.find((x) => x.id === id);
      if (s) fn(s);
    }, key && `step.${id}.${key}`);

  const changeKind = (s: StepSpec, kind: StepSpec['kind']) =>
    edit((w) => {
      const i = w.steps.findIndex((x) => x.id === s.id);
      const base = { id: s.id, after: s.after, priority: s.priority, deadline: s.deadline, name: s.name };
      w.steps[i] =
        kind === 'compute'
          ? { ...base, kind, on: procs[0] ?? '', cycles: 100000 }
          : kind === 'transfer'
            ? { ...base, kind, from: endpoints[0] ?? '', to: procs[0] ?? '', bytes: '64 KiB' }
            : { ...base, kind, time: '100 us' };
    });

  return (
    <Card
      title={`Steps (${wp.steps.length})`}
      actions={
        <>
          <span className="mr-1 text-[11.5px] text-muted">Drag between nodes to add a dependency; select an arrow + Delete to remove it</span>
          {(['compute', 'transfer', 'delay'] as const).map((k) => (
            <button key={k} className="btn sm" onClick={() => update((m) => void newStep(m, wp.id, k))}>
              + {k[0].toUpperCase() + k.slice(1)}
            </button>
          ))}
        </>
      }
    >
      <ReactFlowProvider>
        <StepGraph wp={wp} edit={edit} />
      </ReactFlowProvider>
      <div className="mt-3 overflow-x-auto">
        <table className="tbl min-w-[980px]">
          <thead>
            <tr>
              <th className="w-[130px]">Step</th>
              <th className="w-[112px]">Kind</th>
              <th>Resource</th>
              <th className="w-[240px]">Amount</th>
              <th className="w-[200px]">After</th>
              <th className="w-[64px]">Priority</th>
              <th className="w-[36px]" />
            </tr>
          </thead>
          <tbody>
            {wp.steps.map((s) => (
              <tr key={s.id}>
                <td className="align-top">
                  <IdField value={s.id} taken={wp.steps.map((x) => x.id)} onCommit={(v) => update((m) => renameStep(m, wp.id, s.id, v))} />
                </td>
                <td className="align-top">
                  <Select value={s.kind} options={['compute', 'transfer', 'delay'] as const} onChange={(k) => changeKind(s, k)} />
                </td>
                <td className="align-top">
                  {s.kind === 'compute' ? (
                    <Select value={s.on} options={procs} onChange={(v) => setStep(s.id, (x) => void ((x as typeof s).on = v))} />
                  ) : s.kind === 'transfer' ? (
                    <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-1">
                      <Select value={s.from} options={endpoints} onChange={(v) => setStep(s.id, (x) => void ((x as typeof s).from = v))} />
                      <span className="text-muted">→</span>
                      <Select value={s.to} options={endpoints} onChange={(v) => setStep(s.id, (x) => void ((x as typeof s).to = v))} />
                      <span className="col-span-3 flex items-center gap-1">
                        <span className="text-[11.5px] text-muted">via</span>
                        <Select
                          value={s.via ?? ''}
                          options={[{ value: '', label: 'auto (endpoint processor or only DMA)' }, ...masters.map((x) => ({ value: x, label: x }))]}
                          onChange={(v) =>
                            setStep(s.id, (x) => {
                              if (v) (x as typeof s).via = v;
                              else delete (x as typeof s).via;
                            })
                          }
                        />
                      </span>
                    </div>
                  ) : (
                    <span className="text-muted">pure latency</span>
                  )}
                </td>
                <td className="align-top">
                  {s.kind === 'compute' ? (
                    <ExprField value={s.cycles} kind="work" scope={scope} onChange={(v) => setStep(s.id, (x) => void ((x as typeof s).cycles = v ?? ''), 'cycles')} />
                  ) : s.kind === 'transfer' ? (
                    <ExprField value={s.bytes} kind="bytes" scope={scope} onChange={(v) => setStep(s.id, (x) => void ((x as typeof s).bytes = v ?? ''), 'bytes')} />
                  ) : (
                    <ExprField value={s.time} kind="time" scope={scope} onChange={(v) => setStep(s.id, (x) => void ((x as typeof s).time = v ?? ''), 'time')} />
                  )}
                </td>
                <td className="align-top">
                  <div className="flex flex-wrap items-center gap-1">
                    {(s.after ?? []).map((a) => (
                      <span key={a} className="inline-flex items-center rounded-md border border-line bg-surface-2 py-0.5 pl-1.5 font-mono text-[11.5px]">
                        {a}
                        <button
                          className="px-1 text-muted hover:text-critical"
                          onClick={() =>
                            setStep(s.id, (x) => {
                              x.after = (x.after ?? []).filter((y) => y !== a);
                              if (!x.after.length) delete x.after;
                            })
                          }
                        >
                          ×
                        </button>
                      </span>
                    ))}
                    <select
                      className="ctl !w-[64px] !min-h-[22px] !py-0 text-[11.5px]"
                      value=""
                      onChange={(e) => e.target.value && setStep(s.id, (x) => void (x.after = [...(x.after ?? []), e.target.value]))}
                    >
                      <option value="">+</option>
                      {wp.steps
                        .filter((o) => o.id !== s.id && !(s.after ?? []).includes(o.id))
                        .map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.id}
                          </option>
                        ))}
                    </select>
                  </div>
                </td>
                <td className="align-top">
                  <input
                    className="ctl num"
                    type="number"
                    placeholder={String(wp.priority ?? 0)}
                    value={s.priority ?? ''}
                    onChange={(e) =>
                      setStep(
                        s.id,
                        (x) => {
                          if (e.target.value === '') delete x.priority;
                          else x.priority = Number(e.target.value);
                        },
                        'priority',
                      )
                    }
                  />
                </td>
                <td className="align-top">
                  <button className="btn sm ghost" title="Delete step (its dependents inherit its dependencies)" onClick={() => update((m) => removeStep(m, wp.id, s.id))}>
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <details className="mt-3 text-[12px] text-ink-2">
        <summary className="cursor-pointer select-none font-medium text-ink">Expression reference</summary>
        <div className="mt-2 grid gap-x-6 gap-y-1 md:grid-cols-2">
          <div>
            <b>Units</b> — ns us ms s · B KiB MiB kB MB bit · Hz MHz GHz · GB/s. Give every term a unit: <code>64 B + 1 KiB</code>.
          </div>
          <div>
            <b>Compute amount</b> — a plain number is cycles at the processor clock; a time (<code>12 us</code>) is a fixed duration.
          </div>
          <div>
            <b>Variables</b> — every parameter, this workplan's per-job variables, <code>job</code> (index), <code>t</code> (activation, s),{' '}
            <code>in_bytes</code> (bytes delivered by preceding transfers).
          </div>
          <div>
            <b>Random</b> — uniform(a,b) normal(μ,σ) exponential(mean) lognormal(median,σ) triangular(a,mode,b) choice(…) chance(p) poisson(λ); clamp(x,lo,hi) and
            all of mathjs (round, log2, min, max, …).
          </div>
          <div>
            <b>Precedence</b> — <code>1/fps s</code> is 1/(fps·s), a frequency. Write <code>1 s / fps</code>.
          </div>
          <div>
            <b>Transfers</b> — data flows source → initiator → destination. A memory-to-memory copy needs a DMA or processor in <code>via</code>; on a shared
            bus both legs consume bandwidth.
          </div>
        </div>
      </details>
      <OptionalStepFields wp={wp} setStep={setStep} />
    </Card>
  );
}

/** Less common per-step options, kept out of the main table. */
function OptionalStepFields({ wp, setStep }: { wp: WorkplanSpec; setStep: (id: string, fn: (s: StepSpec) => void, key?: string) => void }) {
  const scope = useParamScope();
  return (
    <details className="mt-2 text-[12px]">
      <summary className="cursor-pointer select-none font-medium">Per-step deadlines and transfer weights</summary>
      <table className="tbl mt-2 max-w-[760px]">
        <thead>
          <tr>
            <th>Step</th>
            <th>Deadline from activation</th>
            <th>Link share weight</th>
          </tr>
        </thead>
        <tbody>
          {wp.steps.map((s) => (
            <tr key={s.id}>
              <td className="font-mono">{s.id}</td>
              <td>
                <ExprField
                  value={s.deadline}
                  kind="time"
                  scope={scope}
                  optional
                  placeholder="none"
                  onChange={(v) =>
                    setStep(
                      s.id,
                      (x) => {
                        if (v === undefined || v === '') delete x.deadline;
                        else x.deadline = v;
                      },
                      'deadline',
                    )
                  }
                />
              </td>
              <td>
                {s.kind === 'transfer' ? (
                  <input
                    className="ctl num"
                    type="number"
                    min={0.01}
                    step={0.5}
                    placeholder="1"
                    value={s.weight ?? ''}
                    onChange={(e) =>
                      setStep(
                        s.id,
                        (x) => {
                          if (e.target.value === '') delete (x as typeof s).weight;
                          else (x as typeof s).weight = Number(e.target.value);
                        },
                        'weight',
                      )
                    }
                  />
                ) : (
                  <span className="text-muted">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}
