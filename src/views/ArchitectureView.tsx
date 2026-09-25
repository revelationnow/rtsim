import dagre from '@dagrejs/dagre';
import {
  applyNodeChanges,
  Background,
  ConnectionMode,
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import { useEffect, useMemo, useState } from 'react';
import { addComponent, allComponentIds, hasLink, kindOf, removeComponent, renameComponent } from '../model/edit';
import type { BusProtocol, BusSpec, ComponentKind, DmaSpec, MemorySpec, Model, ProcessorSpec } from '../model/types';
import { Card, Checkbox, ExprField, Field, IdField, Select, TextField, UtilBar } from '../ui/components';
import { fmtBytes, fmtPct, fmtRate } from '../ui/format';
import { useCompiled, useParamScope } from '../ui/hooks';
import type { CBus } from '../model/compile';
import type { ReactNode } from 'react';
import { useStore } from '../ui/store';

const PROTOCOL_LABEL: Record<BusProtocol, string> = { generic: 'Generic', axi: 'AXI', noc: 'NoC', pcie: 'PCIe' };

const KIND_LABEL: Record<ComponentKind, string> = { processor: 'Processor / HW block', memory: 'Memory', bus: 'Bus / interconnect', dma: 'DMA engine' };
const NODE_W: Record<ComponentKind, number> = { processor: 156, memory: 164, bus: 240, dma: 140 };
const NODE_H: Record<ComponentKind, number> = { processor: 74, memory: 74, bus: 64, dma: 60 };

/** Layered SoC layout: masters above, interconnect in the middle, memories below. */
export function autoLayout(m: Model): Record<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'TB', nodesep: 24, ranksep: 64, marginx: 20, marginy: 20 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const id of allComponentIds(m)) {
    const k = kindOf(m, id)!;
    g.setNode(id, { width: NODE_W[k], height: NODE_H[k] });
  }
  const rank = (id: string) => ({ processor: 0, dma: 0, bus: 1, memory: 2 })[kindOf(m, id) ?? 'bus'];
  for (const [a, b] of m.links) {
    if (!g.hasNode(a) || !g.hasNode(b)) continue;
    const [u, v] = rank(a) <= rank(b) ? [a, b] : [b, a];
    g.setEdge(u, v);
  }
  dagre.layout(g);
  const out: Record<string, { x: number; y: number }> = {};
  for (const id of g.nodes()) {
    const n = g.node(id);
    out[id] = { x: Math.round(n.x - n.width / 2), y: Math.round(n.y - n.height / 2) };
  }
  return out;
}

interface NodeData extends Record<string, unknown> {
  kind: ComponentKind;
  title: string;
  id: string;
  lines: string[];
  util: { label: string; value: number }[];
}

function ComponentNode({ data, selected }: NodeProps<Node<NodeData>>) {
  const k = data.kind;
  const shape =
    k === 'bus'
      ? 'rounded-full px-5'
      : k === 'memory'
        ? 'rounded-md border-b-[3px]'
        : k === 'dma'
          ? 'rounded-md border-dashed'
          : 'rounded-md';
  return (
    <div
      className={`border bg-surface px-3 py-2 shadow-sm ${shape} ${selected ? 'border-accent ring-2 ring-[var(--accent-wash)]' : 'border-line-strong'}`}
      style={{ width: NODE_W[k], minHeight: NODE_H[k] }}
    >
      <Handle type="source" position={Position.Top} id="t" />
      <Handle type="source" position={Position.Bottom} id="b" />
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate font-semibold">{data.title}</span>
        <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted">{k}</span>
      </div>
      {data.lines.map((l, i) => (
        <div key={i} className="truncate text-[11px] text-ink-2">
          {l}
        </div>
      ))}
      {data.util.map((u) => (
        <div key={u.label} className="mt-1 flex items-center gap-1.5 text-[10.5px] text-ink-2">
          {u.label ? <span className="w-[26px]">{u.label}</span> : null}
          <UtilBar value={u.value} width={k === 'bus' ? 150 : 90} showLabel={false} />
          <span className="num">{fmtPct(u.value, 0)}</span>
        </div>
      ))}
    </div>
  );
}

const nodeTypes = { comp: ComponentNode };

export function ArchitectureView() {
  return (
    <div className="flex h-full min-h-0 flex-col lg:flex-row">
      <div className="relative min-h-[420px] min-w-0 flex-1">
        <ReactFlowProvider>
          <Diagram />
        </ReactFlowProvider>
      </div>
      <aside className="w-full shrink-0 overflow-auto border-t border-line bg-page p-3 lg:w-[380px] lg:border-l lg:border-t-0">
        <Inspector />
      </aside>
    </div>
  );
}

function Diagram() {
  const model = useStore((s) => s.model);
  const update = useStore((s) => s.update);
  const selection = useStore((s) => s.selection);
  const select = useStore((s) => s.select);
  const run = useStore((s) => s.run);
  const c = useCompiled();
  const flow = useReactFlow();

  // Give every component a position; new ones are laid out automatically.
  useEffect(() => {
    const ids = allComponentIds(model);
    const missing = ids.filter((id) => !model.layout?.[id]);
    if (!missing.length) return;
    const auto = autoLayout(model);
    update((m) => {
      m.layout ??= {};
      const fresh = missing.length === ids.length;
      for (const id of missing) m.layout[id] = fresh ? auto[id] : { x: auto[id].x + 40, y: auto[id].y + 40 };
    }, 'layout');
    if (missing.length === ids.length) setTimeout(() => flow.fitView({ padding: 0.15 }), 50);
  }, [model, update, flow]);

  const util = useMemo(() => {
    const u = new Map<string, number>();
    for (const r of run.result?.resources ?? []) u.set(r.id, r.utilization);
    return u;
  }, [run.result]);

  const derived: Node<NodeData>[] = useMemo(() => {
    const cm = c.ok ? c.model : null;
    const mk = (kind: ComponentKind, spec: { id: string; name?: string }, lines: string[], utilIds: [string, string][]): Node<NodeData> => ({
      id: spec.id,
      type: 'comp',
      position: model.layout?.[spec.id] ?? { x: 0, y: 0 },
      selected: selection?.id === spec.id,
      data: {
        kind,
        id: spec.id,
        title: spec.name || spec.id,
        lines,
        util: utilIds.filter(([rid]) => util.has(rid)).map(([rid, label]) => ({ label, value: util.get(rid)! })),
      },
    });
    const out: Node<NodeData>[] = [];
    for (const p of model.processors) {
      const cp = cm?.processors.find((x) => x.id === p.id);
      const policy = { fifo: 'FIFO', 'fixed-priority': 'Fixed prio', edf: 'EDF' }[p.policy ?? 'fifo'];
      out.push(mk('processor', p, [`${p.cores ?? 1} × ${p.freq}`, `${policy}${p.preemptive ? ', preemptive' : ''}`], [[p.id, '']]));
      void cp;
    }
    for (const m of model.memories) {
      const cmem = cm?.memories.find((x) => x.id === m.id);
      out.push(
        mk(
          'memory',
          m,
          [cmem ? `${fmtBytes(cmem.sizeBytes)} · ${fmtRate(cmem.bwBps)}` : String(m.size), `lat ${m.readLatency}${m.duplex ? ' · duplex' : ''}`],
          m.duplex ? [[`${m.id}:rd`, 'rd'], [`${m.id}:wr`, 'wr']] : [[m.id, '']],
        ),
      );
    }
    for (const b of model.buses) {
      const cb = cm?.buses.find((x) => x.id === b.id);
      out.push(
        mk(
          'bus',
          b,
          [
            `${cb ? fmtRate(cb.bwBps) : '?'}${cb?.duplex ? ' per direction' : ''} · ${b.latency ?? '0 ns'}`,
            cb ? `${PROTOCOL_LABEL[cb.protocol]} · ${cb.mode === 'packet' ? `packets of ${fmtBytes(cb.pkt.payload)}` : 'fluid'}` : '',
          ].filter(Boolean),
          cb?.duplex ? [[`${b.id}:rd`, 'rd'], [`${b.id}:wr`, 'wr']] : [[b.id, '']],
        ),
      );
    }
    for (const d of model.dmas ?? []) out.push(mk('dma', d, [`${d.channels ?? 1} channel${Number(d.channels ?? 1) > 1 ? 's' : ''}`], [[d.id, '']]));
    return out;
  }, [model, selection, util, c]);

  // React Flow keeps measurements and drag state on the node objects, so hold them locally
  // and re-derive from the model whenever it changes.
  const [nodes, setNodes] = useState<Node<NodeData>[]>([]);
  useEffect(() => {
    setNodes((prev) => {
      const old = new Map(prev.map((n) => [n.id, n]));
      return derived.map((n) => ({ ...n, measured: old.get(n.id)?.measured }));
    });
  }, [derived]);

  // Fit once the laid-out nodes have been measured, and whenever components are added or removed.
  const measuredCount = nodes.filter((n) => n.measured).length;
  useEffect(() => {
    if (!measuredCount) return;
    const t = setTimeout(() => flow.fitView({ padding: 0.15, maxZoom: 1.2 }), 30);
    return () => clearTimeout(t);
  }, [measuredCount, flow]);

  const edges: Edge[] = useMemo(
    () =>
      model.links.map(([a, b]) => {
        const pa = model.layout?.[a]?.y ?? 0;
        const pb = model.layout?.[b]?.y ?? 0;
        const [s, t] = pa <= pb ? [a, b] : [b, a];
        return { id: `${a}--${b}`, source: s, target: t, sourceHandle: 'b', targetHandle: 't', type: 'default', style: { strokeWidth: 2 } };
      }),
    [model.links, model.layout],
  );

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      connectionMode={ConnectionMode.Loose}
      fitView
      minZoom={0.2}
      proOptions={{ hideAttribution: true }}
      onNodeClick={(_, n) => select({ kind: (n.data as NodeData).kind, id: n.id })}
      onPaneClick={() => select(null)}
      onNodesChange={(changes) => {
        setNodes((ns) => applyNodeChanges(changes, ns) as Node<NodeData>[]);
        for (const ch of changes) if (ch.type === 'remove') update((m) => removeComponent(m, ch.id));
      }}
      onNodeDragStop={(_, __, dragged) =>
        update((m) => {
          m.layout ??= {};
          for (const n of dragged) m.layout[n.id] = { x: Math.round(n.position.x), y: Math.round(n.position.y) };
        })
      }
      onEdgesChange={(changes) => {
        for (const ch of changes) {
          if (ch.type === 'remove') {
            const [a, b] = ch.id.split('--');
            update((m) => void (m.links = m.links.filter(([x, y]) => !((x === a && y === b) || (x === b && y === a)))));
          }
        }
      }}
      onConnect={(conn) => {
        if (!conn.source || !conn.target || conn.source === conn.target) return;
        if (hasLink(model, conn.source, conn.target)) return;
        update((m) => void m.links.push([conn.source!, conn.target!]));
      }}
      deleteKeyCode={['Backspace', 'Delete']}
    >
      <Background gap={20} size={1} />
      <Controls showInteractive={false} />
      <div className="absolute left-3 right-3 top-3 z-10 flex flex-wrap gap-1.5">
        {(['processor', 'memory', 'bus', 'dma'] as ComponentKind[]).map((k) => (
          <button
            key={k}
            className="btn sm"
            onClick={() => {
              let id = '';
              update((m) => void (id = addComponent(m, k)));
              select({ kind: k, id });
            }}
          >
            + {k === 'processor' ? 'Processor' : k === 'memory' ? 'Memory' : k === 'bus' ? 'Bus' : 'DMA'}
          </button>
        ))}
        <button
          className="btn sm"
          title="Re-arrange every component"
          onClick={() => {
            update((m) => void (m.layout = { ...m.layout, ...autoLayout(m) }));
            setTimeout(() => flow.fitView({ padding: 0.15 }), 50);
          }}
        >
          Auto-layout
        </button>
      </div>
      <div className="absolute bottom-3 left-14 right-3 z-10 hidden rounded-md sm:block bg-surface/90 px-2 py-1 text-[11px] text-muted">
        Drag from a handle to link components · select + Delete to remove{run.result ? ' · bars show average utilization from the last run' : ''}
      </div>
    </ReactFlow>
  );
}

function Inspector() {
  const model = useStore((s) => s.model);
  const selection = useStore((s) => s.selection);
  const select = useStore((s) => s.select);
  if (selection && kindOf(model, selection.id)) return <ComponentEditor id={selection.id} kind={kindOf(model, selection.id)!} />;

  const groups: [ComponentKind, { id: string; name?: string }[]][] = [
    ['processor', model.processors],
    ['memory', model.memories],
    ['bus', model.buses],
    ['dma', model.dmas ?? []],
  ];
  return (
    <div className="space-y-3">
      <Card title="Components">
        <p className="mb-2 text-ink-2">
          Select a component in the diagram to edit it. Transfers are routed along the fewest bus hops between their source, the initiating DMA or
          processor, and their destination.
        </p>
        {groups.map(([k, list]) => (
          <div key={k} className="mb-2">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">{KIND_LABEL[k]}s</div>
            <div className="mt-1 flex flex-wrap gap-1">
              {list.length ? (
                list.map((x) => (
                  <button key={x.id} className="btn sm" onClick={() => select({ kind: k, id: x.id })}>
                    {x.name || x.id}
                  </button>
                ))
              ) : (
                <span className="text-muted">none</span>
              )}
            </div>
          </div>
        ))}
      </Card>
      <Card title="Description">
        <textarea
          className="ctl min-h-[90px]"
          value={model.description ?? ''}
          placeholder="What this model represents, assumptions, sources…"
          onChange={(e) => useStore.getState().update((m) => void (m.description = e.target.value), 'description')}
        />
      </Card>
    </div>
  );
}

function ComponentEditor({ id, kind }: { id: string; kind: ComponentKind }) {
  const model = useStore((s) => s.model);
  const update = useStore((s) => s.update);
  const select = useStore((s) => s.select);
  const scope = useParamScope();
  const c = useCompiled();
  const run = useStore((s) => s.run);
  const ids = allComponentIds(model);

  const spec = [...model.processors, ...model.memories, ...model.buses, ...(model.dmas ?? [])].find((x) => x.id === id)!;
  /** Edits one field of this component in the draft model. */
  const set = <T,>(field: string, v: T) =>
    update((m) => {
      const s = [...m.processors, ...m.memories, ...m.buses, ...(m.dmas ?? [])].find((x) => x.id === id) as unknown as Record<string, unknown>;
      if (v === undefined || v === '') delete s[field];
      else s[field] = v;
    }, `${id}.${field}`);

  const neighbours = model.links.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a));
  const usedBy: string[] = [];
  for (const w of model.workplans)
    for (const s of w.steps) {
      if ((s.kind === 'compute' && s.on === id) || (s.kind === 'transfer' && (s.from === id || s.to === id || s.via === id))) usedBy.push(`${w.id}.${s.id}`);
    }

  const expr = (field: string, label: string, kind2: Parameters<typeof ExprField>[0]['kind'], hint?: string, optional = true) => (
    <Field label={label} hint={hint}>
      <ExprField value={(spec as unknown as Record<string, string | number | undefined>)[field]} kind={kind2} scope={scope} optional={optional} onChange={(v) => set(field, v)} />
    </Field>
  );

  const results = run.result?.resources.filter((r) => r.id === id || r.id.startsWith(`${id}:`)) ?? [];
  const foot = run.result?.footprints.find((f) => f.id === id);
  const cb = c.ok && kind === 'bus' ? c.model.buses.find((b) => b.id === id) : null;

  return (
    <div className="space-y-3">
      <Card
        title={
          <span>
            {spec.name || spec.id} <span className="ml-1 font-normal text-muted">{KIND_LABEL[kind]}</span>
          </span>
        }
        actions={
          <button className="btn sm ghost" onClick={() => select(null)}>
            Close
          </button>
        }
      >
        <Field label="Id">
          <IdField
            value={id}
            taken={ids}
            onCommit={(v) => {
              update((m) => renameComponent(m, id, v));
              select({ kind, id: v });
            }}
          />
        </Field>
        <Field label="Name">
          <TextField value={spec.name ?? ''} onChange={(v) => set('name', v)} placeholder={id} />
        </Field>
        {kind === 'processor' && (
          <>
            {expr('freq', 'Clock', 'freq', 'Compute steps given in cycles run at this clock', false)}
            {expr('cores', 'Cores / units', 'count', 'Identical execution units sharing one ready queue')}
            <Field label="Scheduling">
              <Select
                value={(spec as ProcessorSpec).policy ?? 'fifo'}
                options={[
                  { value: 'fifo', label: 'FIFO (run to completion in order)' },
                  { value: 'fixed-priority', label: 'Fixed priority (higher wins)' },
                  { value: 'edf', label: 'EDF (earliest deadline first)' },
                ]}
                onChange={(v) => set('policy', v)}
              />
            </Field>
            <Field label="Preemptive">
              <Checkbox checked={(spec as ProcessorSpec).preemptive ?? false} onChange={(v) => set('preemptive', v || undefined)} label="Higher-priority work displaces running work" />
            </Field>
            {expr('contextSwitch', 'Dispatch overhead', 'time', 'Charged each time a step is dispatched onto a core')}
            {expr('maxOutstanding', 'Max outstanding', 'count', 'Transactions in flight when this block masters a transfer; caps its rate at outstanding × burst / round-trip latency')}
            {expr('burst', 'Burst size', 'bytes')}
          </>
        )}
        {kind === 'memory' && (
          <>
            {expr('size', 'Capacity', 'bytes', 'Used to check peak buffer footprint', false)}
            {expr('bandwidth', 'Bandwidth', 'bandwidth', 'Sustained bandwidth of the controller / array', false)}
            {expr('readLatency', 'Read latency', 'time', undefined, false)}
            {expr('writeLatency', 'Write latency', 'time', 'Defaults to the read latency')}
            <Field label="Duplex">
              <Checkbox checked={(spec as MemorySpec).duplex ?? false} onChange={(v) => set('duplex', v || undefined)} label="Independent read and write bandwidth" />
            </Field>
          </>
        )}
        {kind === 'bus' && <BusFields spec={spec as BusSpec} cb={cb} set={set} expr={expr} />}
        {kind === 'dma' && (
          <>
            {expr('channels', 'Channels', 'count', 'Concurrent transfers; more requests wait')}
            <Field label="Queueing">
              <Select
                value={(spec as DmaSpec).policy ?? 'fifo'}
                options={[
                  { value: 'fifo', label: 'FIFO' },
                  { value: 'priority', label: 'Priority' },
                ]}
                onChange={(v) => set('policy', v)}
              />
            </Field>
            {expr('maxOutstanding', 'Max outstanding', 'count', 'Transactions in flight per channel; caps rate at outstanding × burst / round-trip latency')}
            {expr('burst', 'Burst size', 'bytes')}
          </>
        )}
        <div className="mt-3 flex justify-end">
          <button
            className="btn sm"
            onClick={() => {
              update((m) => removeComponent(m, id));
              select(null);
            }}
          >
            Delete component
          </button>
        </div>
      </Card>

      <Card title="Links">
        <div className="flex flex-wrap gap-1">
          {neighbours.map((n) => (
            <span key={n} className="inline-flex items-center gap-1 rounded-md border border-line bg-surface-2 py-0.5 pl-2 pr-1">
              {n}
              <button
                className="px-1 text-muted hover:text-critical"
                title="Remove link"
                onClick={() => update((m) => void (m.links = m.links.filter(([a, b]) => !((a === id && b === n) || (a === n && b === id)))))}
              >
                ×
              </button>
            </span>
          ))}
          {!neighbours.length ? <span className="text-muted">Not linked — transfers cannot reach it.</span> : null}
        </div>
        <select
          className="ctl mt-2"
          value=""
          onChange={(e) => e.target.value && update((m) => void m.links.push([id, e.target.value]))}
        >
          <option value="">Link to…</option>
          {ids
            .filter((x) => x !== id && !neighbours.includes(x))
            .map((x) => (
              <option key={x} value={x}>
                {x} ({kindOf(model, x)})
              </option>
            ))}
        </select>
      </Card>

      {results.length || foot ? (
        <Card title="Last run">
          <table className="tbl">
            <tbody>
              {results.map((r) => (
                <tr key={r.id}>
                  <td>{r.lane === 'rd' ? 'Read' : r.lane === 'wr' ? 'Write' : 'Utilization'}</td>
                  <td className="r">
                    <UtilBar value={r.utilization} width={80} />
                  </td>
                  <td className="r text-ink-2">peak {fmtPct(r.peakWindowUtil)}</td>
                </tr>
              ))}
              {foot ? (
                <tr>
                  <td>Peak buffers</td>
                  <td className="r" colSpan={2}>
                    {fmtBytes(foot.peak)} of {fmtBytes(foot.size)}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </Card>
      ) : null}

      <Card title="Used by">
        {usedBy.length ? (
          <div className="flex flex-wrap gap-1">
            {usedBy.map((u) => (
              <button
                key={u}
                className="btn sm font-mono"
                onClick={() => {
                  useStore.getState().selectWp(u.split('.')[0]);
                  useStore.getState().setView('workplans');
                }}
              >
                {u}
              </button>
            ))}
          </div>
        ) : (
          <span className="text-muted">No workplan step uses this component.</span>
        )}
      </Card>
    </div>
  );
}

/** Bus editor: protocol and model, bandwidth, and packetization with the preset values as hints. */
function BusFields({
  spec,
  cb,
  set,
  expr,
}: {
  spec: BusSpec;
  cb: CBus | null | undefined;
  set: (field: string, v: unknown) => void;
  expr: (field: string, label: string, kind: Parameters<typeof ExprField>[0]['kind'], hint?: string, optional?: boolean) => ReactNode;
}) {
  const protocol = spec.protocol ?? 'generic';
  const mode = spec.model ?? (protocol === 'generic' ? 'fluid' : 'packet');
  const pkt = cb?.pkt;
  const perPacket = pkt && Number.isFinite(pkt.payload) ? pkt.payload / (pkt.payload + pkt.headerBytes + (pkt.gapPs / 1e12) * cb!.bwBps) : null;
  const hint = (v: string) => `${v} (${PROTOCOL_LABEL[protocol]} default)`;
  return (
    <>
      <Field label="Protocol" hint="Fills in packet size, header, arbitration and switching defaults">
        <Select
          value={protocol}
          options={[
            { value: 'generic', label: 'Generic' },
            { value: 'axi', label: 'AXI (bursts on separate R/W channels)' },
            { value: 'noc', label: 'NoC (flits, wormhole routing)' },
            { value: 'pcie', label: 'PCIe (TLPs over serial lanes)' },
          ]}
          onChange={(v) => set('protocol', v === 'generic' ? undefined : v)}
        />
      </Field>
      <Field label="Model" hint="Fluid shares bandwidth as continuous flows (fast). Packet arbitrates and serializes every packet, so small transfers see real waits.">
        <Select
          value={mode}
          options={[
            { value: 'fluid', label: 'Fluid (average bandwidth sharing)' },
            { value: 'packet', label: 'Packet level (per-packet arbitration and latency)' },
          ]}
          onChange={(v) => set('model', v === (protocol === 'generic' ? 'fluid' : 'packet') ? undefined : v)}
        />
      </Field>
      {protocol === 'pcie' ? (
        <>
          <Field label="Generation">
            <Select
              value={String(spec.gen ?? 4)}
              options={['1', '2', '3', '4', '5', '6'].map((g) => ({ value: g, label: `Gen ${g} (${{ 1: 2.5, 2: 5, 3: 8, 4: 16, 5: 32, 6: 64 }[g]} GT/s)` }))}
              onChange={(v) => set('gen', v === '4' ? undefined : Number(v))}
            />
          </Field>
          <Field label="Lanes">
            <Select value={String(spec.lanes ?? 4)} options={['1', '2', '4', '8', '16'].map((l) => ({ value: l, label: `x${l}` }))} onChange={(v) => set('lanes', v === '4' ? undefined : Number(v))} />
          </Field>
          {expr('efficiency', 'Efficiency', 'count', 'Share of the encoded rate left after DLLPs, flow control and SKP ordered sets (default 0.95)')}
        </>
      ) : (
        <>
          {expr('width', 'Data width', 'bytes', 'e.g. "128 bit"')}
          {expr('freq', 'Clock', 'freq')}
          {expr('efficiency', 'Efficiency', 'count', 'Fraction of width × clock achievable (0–1). Packet headers and gaps are counted separately below.')}
        </>
      )}
      {expr('bandwidth', 'Bandwidth override', 'bandwidth', 'Set this to give the link bandwidth directly')}
      <Field label="Effective">
        <span className="num pt-1 text-ink-2">
          {cb ? `${fmtRate(cb.bwBps)}${cb.duplex ? ' per direction' : ''}` : '—'}
          {perPacket !== null && perPacket < 1 ? ` · ${(perPacket * 100).toFixed(1)}% payload at full packets` : ''}
        </span>
      </Field>
      {expr('latency', mode === 'packet' ? 'Latency per packet' : 'Hop latency', 'time', 'Arbitration + pipeline latency per traversal')}
      <Field label="Duplex">
        <Checkbox checked={cb?.duplex ?? spec.duplex ?? false} onChange={(v) => set('duplex', v)} label="Separate read and write channels" />
      </Field>
      <div className="mt-2 border-t border-line pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted">Packets</div>
      <Field label="Max payload" hint="Largest data payload per packet: AXI burst length × width, NoC packet size, PCIe Max Payload Size">
        <ExprPlaceholder field="maxPayload" spec={spec} set={set} kind="bytes" placeholder={pkt && Number.isFinite(pkt.payload) ? hint(fmtBytes(pkt.payload)) : 'no packets'} />
      </Field>
      {protocol === 'pcie' || spec.readPayload !== undefined ? (
        <Field label="Read completion" hint="Payload per completion for data returned to a reader; root complexes often split completions at 64 or 128 B">
          <ExprPlaceholder field="readPayload" spec={spec} set={set} kind="bytes" placeholder={pkt ? hint(fmtBytes(pkt.readPayload)) : ''} />
        </Field>
      ) : null}
      {protocol === 'pcie' || spec.maxRequest !== undefined ? (
        <Field label="Max read request" hint="Bytes per read request (PCIe MRRS); the initiator's outstanding limit counts these">
          <ExprPlaceholder field="maxRequest" spec={spec} set={set} kind="bytes" placeholder={pkt ? hint(fmtBytes(pkt.maxRequest)) : ''} />
        </Field>
      ) : null}
      <Field label="Header" hint="Overhead bytes serialized with each packet: header flit, TLP header + sequence + LCRC + framing">
        <ExprPlaceholder field="header" spec={spec} set={set} kind="bytes" placeholder={pkt ? hint(fmtBytes(pkt.headerBytes)) : ''} />
      </Field>
      <Field label="Gap per packet" hint="Idle link time between packets, e.g. an AXI arbitration bubble">
        <ExprPlaceholder field="packetGap" spec={spec} set={set} kind="time" placeholder={pkt ? hint(pkt.gapPs ? `${pkt.gapPs / 1000} ns` : '0') : ''} />
      </Field>
      {mode === 'packet' ? (
        <>
          <Field label="Arbitration">
            <Select
              value={spec.arbitration ?? 'round-robin'}
              options={[
                { value: 'round-robin', label: 'Round-robin between initiators' },
                { value: 'priority', label: 'Priority (higher first)' },
                { value: 'fifo', label: 'FIFO (arrival order)' },
              ]}
              onChange={(v) => set('arbitration', v === 'round-robin' ? undefined : v)}
            />
          </Field>
          <Field label="Switching" hint="Cut-through (wormhole) forwards a packet once its header is through; store-and-forward waits for the whole packet at each hop">
            <Select
              value={spec.switching ?? (pkt?.cutThrough ? 'cut-through' : 'store-and-forward')}
              options={[
                { value: 'cut-through', label: 'Cut-through' },
                { value: 'store-and-forward', label: 'Store-and-forward' },
              ]}
              onChange={(v) => set('switching', v)}
            />
          </Field>
        </>
      ) : null}
    </>
  );
}

function ExprPlaceholder({
  field,
  spec,
  set,
  kind,
  placeholder,
}: {
  field: keyof BusSpec;
  spec: BusSpec;
  set: (field: string, v: unknown) => void;
  kind: Parameters<typeof ExprField>[0]['kind'];
  placeholder: string;
}) {
  const scope = useParamScope();
  return <ExprField value={spec[field] as string | number | undefined} kind={kind} scope={scope} optional placeholder={placeholder} onChange={(v) => set(field, v)} />;
}
