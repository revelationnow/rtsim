import { useMemo } from 'react';
import { BUS_TEMPLATES } from '../model/busTypes';
import type { CBus } from '../model/compile';
import {
  addBusType,
  BUS_FIELD_KEYS,
  busTypeUsers,
  removeBusType,
  renameBusType,
  saveBusAsType,
} from '../model/edit';
import { compileExpr, evalExpr, withRng } from '../model/expr';
import type { BusFields, BusSpec, BusTypeSpec, Expr } from '../model/types';
import { Card, ExprField, Field, IdField, TextField, type PreviewKind } from '../ui/components';
import { fmtBytes, fmtRate } from '../ui/format';
import { useCompiled, useParamScope } from '../ui/hooks';
import { useStore } from '../ui/store';

type FieldKey = (typeof BUS_FIELD_KEYS)[number];

/** Built-in fallbacks when neither the bus nor its type sets a field. */
const DEFAULT_TEXT: Record<FieldKey, string> = {
  model: 'fluid',
  width: 'not set',
  freq: 'not set',
  efficiency: '1',
  bandwidth: 'width × freq × efficiency',
  latency: '0',
  duplex: 'no',
  direction: 'initiator',
  maxPayload: '64 B in packet mode',
  readPayload: 'same as max payload',
  maxRequest: 'unlimited',
  header: '0',
  packetGap: '0',
  arbitration: 'round-robin',
  switching: 'store-and-forward',
};

const EXPR_FIELDS: { key: FieldKey; label: string; kind: PreviewKind; hint: string }[] = [
  { key: 'width', label: 'Data width', kind: 'bytes', hint: 'e.g. "128 bit". Other expressions can use it as width.' },
  { key: 'freq', label: 'Clock', kind: 'freq', hint: 'Other expressions can use it as freq, e.g. a gap of "1 / freq".' },
  { key: 'efficiency', label: 'Efficiency', kind: 'count', hint: 'Fraction of width × clock achievable (0–1). Headers and gaps below are counted separately.' },
  { key: 'bandwidth', label: 'Bandwidth', kind: 'bandwidth', hint: 'Overrides width × clock × efficiency. Any expression, e.g. "lanes * lane_rate * encoding".' },
  { key: 'latency', label: 'Latency', kind: 'time', hint: 'Per traversal: arbitration + pipeline. Per packet in packet mode.' },
];

const PACKET_FIELDS: { key: FieldKey; label: string; kind: PreviewKind; hint: string }[] = [
  { key: 'maxPayload', label: 'Max payload', kind: 'bytes', hint: 'Largest data payload per packet: an AXI burst, NoC packet, PCIe max payload size.' },
  { key: 'readPayload', label: 'Read payload', kind: 'bytes', hint: 'Payload per packet for data returned to a reader, e.g. PCIe completions split at 64 or 128 B.' },
  { key: 'maxRequest', label: 'Max request', kind: 'bytes', hint: 'Largest request an initiator may issue on this bus (PCIe max read request size).' },
  { key: 'header', label: 'Header', kind: 'bytes', hint: 'Overhead bytes serialized with each packet: a header flit, TLP header + sequence + LCRC + framing.' },
  { key: 'packetGap', label: 'Gap per packet', kind: 'time', hint: 'Idle link time between packets, e.g. an arbitration bubble.' },
];

const CHOICES: { key: FieldKey; label: string; hint?: string; options: { value: string; label: string }[] }[] = [
  {
    key: 'model',
    label: 'Model',
    hint: 'Fluid shares bandwidth as continuous flows (fast). Packet level arbitrates and serializes every packet, so small transfers see real waits.',
    options: [
      { value: 'fluid', label: 'Fluid (average bandwidth sharing)' },
      { value: 'packet', label: 'Packet level' },
    ],
  },
  {
    key: 'duplex',
    label: 'Lanes',
    options: [
      { value: 'false', label: 'One shared lane' },
      { value: 'true', label: 'Two independent lanes (duplex)' },
    ],
  },
  {
    key: 'direction',
    label: 'Lane direction',
    hint: 'Initiator: read and write channels relative to the master (AXI, NoC). Physical: the two directions of a point-to-point link (PCIe, SerDes); the bus must link exactly two components.',
    options: [
      { value: 'initiator', label: 'Read / write, relative to the initiator' },
      { value: 'physical', label: 'Physical direction of a point-to-point link' },
    ],
  },
  {
    key: 'arbitration',
    label: 'Arbitration',
    hint: 'Packet mode only.',
    options: [
      { value: 'round-robin', label: 'Round-robin between initiators (byte-fair)' },
      { value: 'priority', label: 'Priority (higher first)' },
      { value: 'fifo', label: 'FIFO (arrival order)' },
    ],
  },
  {
    key: 'switching',
    label: 'Switching',
    hint: 'Packet mode only. Cut-through (wormhole) forwards a packet once its header is through.',
    options: [
      { value: 'store-and-forward', label: 'Store-and-forward' },
      { value: 'cut-through', label: 'Cut-through' },
    ],
  },
];

const show = (v: unknown) => (v === undefined || v === '' ? undefined : String(v));

/** Scope for previewing bus expressions: params, the type's vars with the bus's overrides, width and freq. */
function useBusScope(type: BusTypeSpec | undefined, own: { vars?: Record<string, Expr>; width?: Expr; freq?: Expr } | undefined) {
  const params = useParamScope();
  return useMemo(() => {
    const scope: Record<string, unknown> = { ...params };
    const ev = (e: Expr) => withRng(null, 'mean', () => evalExpr(compileExpr(e, scope, new Set()), scope));
    const names = [...Object.keys(type?.vars ?? {}), ...Object.keys(own?.vars ?? {}).filter((k) => !(k in (type?.vars ?? {})))];
    for (const n of names) {
      try {
        scope[n] = ev(own?.vars?.[n] ?? type!.vars![n]);
      } catch {
        /* shown on the field */
      }
    }
    for (const k of ['width', 'freq'] as const) {
      const e = own?.[k] ?? type?.[k];
      if (e === undefined || e === '') continue;
      try {
        scope[k] = ev(e);
      } catch {
        /* shown on the field */
      }
    }
    return scope;
  }, [params, type, own]);
}

/**
 * Every bus field. `own` holds the values being edited; `inherited` (a bus's type) supplies
 * the values shown as hints and selectable as "from type".
 */
function FieldsEditor({
  own,
  inherited,
  inheritedLabel,
  set,
  scope,
}: {
  own: BusFields;
  inherited: BusFields | null;
  inheritedLabel: string;
  set: (key: FieldKey, v: unknown) => void;
  scope: Record<string, unknown>;
}) {
  const placeholder = (k: FieldKey) => {
    const iv = show(inherited?.[k]);
    return iv !== undefined ? `${inheritedLabel}: ${iv}` : DEFAULT_TEXT[k];
  };
  const choice = (c: (typeof CHOICES)[number]) => {
    const cur = show(own[c.key]) ?? '';
    const iv = show(inherited?.[c.key]);
    const fallback = iv !== undefined ? c.options.find((o) => o.value === iv)?.label ?? iv : c.options.find((o) => o.value === DEFAULT_TEXT[c.key])?.label ?? DEFAULT_TEXT[c.key];
    return (
      <Field key={c.key} label={c.label} hint={c.hint}>
        <select
          className="ctl"
          value={cur}
          onChange={(e) => {
            const v = e.target.value;
            set(c.key, v === '' ? undefined : c.key === 'duplex' ? v === 'true' : v);
          }}
        >
          <option value="">{inherited ? `${inheritedLabel}: ${fallback}` : `Default: ${fallback}`}</option>
          {c.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </Field>
    );
  };
  const expr = (f: (typeof EXPR_FIELDS)[number]) => (
    <Field key={f.key} label={f.label} hint={f.hint}>
      <ExprField value={own[f.key] as Expr | undefined} kind={f.kind} scope={scope} optional placeholder={placeholder(f.key)} onChange={(v) => set(f.key, v)} />
    </Field>
  );
  return (
    <>
      {choice(CHOICES[0])}
      {EXPR_FIELDS.map(expr)}
      {choice(CHOICES[1])}
      {choice(CHOICES[2])}
      <div className="mt-2 border-t border-line pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted">Packets</div>
      <p className="mb-1 text-[11.5px] text-muted">Headers and gaps also count as bandwidth overhead on fluid buses.</p>
      {PACKET_FIELDS.map(expr)}
      {choice(CHOICES[3])}
      {choice(CHOICES[4])}
    </>
  );
}

/** Name/expression rows for a bus type's variables, or a bus's overrides of them. */
function VarsEditor({
  own,
  inherited,
  set,
  scope,
  allowAdd,
}: {
  own: Record<string, Expr>;
  inherited: Record<string, Expr>;
  set: (vars: Record<string, Expr> | undefined) => void;
  scope: Record<string, unknown>;
  allowAdd: boolean;
}) {
  const names = [...Object.keys(inherited), ...Object.keys(own).filter((k) => !(k in inherited))];
  const put = (name: string, v: Expr | undefined) => {
    const next = { ...own };
    if (v === undefined || v === '') delete next[name];
    else next[name] = v;
    set(Object.keys(next).length ? next : undefined);
  };
  return (
    <div className="space-y-1.5">
      {!names.length ? <div className="text-muted">None.</div> : null}
      {names.map((n) => (
        <div key={n} className="grid grid-cols-[110px_1fr_auto] items-start gap-1.5">
          <span className="truncate pt-1 font-mono text-[12px]" title={n}>
            {n}
          </span>
          <ExprField value={own[n]} kind="none" scope={scope} optional placeholder={inherited[n] !== undefined ? `type: ${inherited[n]}` : ''} onChange={(v) => put(n, v)} />
          {n in own ? (
            <button className="btn sm ghost" title={n in inherited ? 'Use the type value' : 'Remove'} onClick={() => put(n, undefined)}>
              ×
            </button>
          ) : (
            <span className="w-[28px]" />
          )}
        </div>
      ))}
      {allowAdd ? (
        <input
          className="ctl font-mono text-[12px]"
          placeholder="+ add variable (type a name, press Enter)"
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            const n = (e.target as HTMLInputElement).value.trim();
            if (!/^[A-Za-z_]\w*$/.test(n) || n in own || n in inherited) return;
            put(n, 1);
            (e.target as HTMLInputElement).value = '';
          }}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bus (inside the component editor)
// ---------------------------------------------------------------------------

export function BusSettings({ bus, compiled }: { bus: BusSpec; compiled: CBus | null | undefined }) {
  const model = useStore((s) => s.model);
  const update = useStore((s) => s.update);
  const selectBusType = useStore((s) => s.selectBusType);
  const types = model.busTypes ?? [];
  const type = types.find((t) => t.id === bus.type);
  const scope = useBusScope(type, bus);
  const edit = (fn: (b: BusSpec) => void, key?: string) =>
    update((m) => {
      const b = m.buses.find((x) => x.id === bus.id);
      if (b) fn(b);
    }, key && `${bus.id}.${key}`);
  const set = (k: string, v: unknown) =>
    edit((b) => {
      const r = b as unknown as Record<string, unknown>;
      if (v === undefined || v === '') delete r[k];
      else r[k] = v;
    }, k);
  const overrides = BUS_FIELD_KEYS.filter((k) => type && bus[k] !== undefined && bus[k] !== '' && k !== 'width' && k !== 'freq');
  const perPacket =
    compiled && Number.isFinite(compiled.pkt.payload)
      ? compiled.pkt.payload / (compiled.pkt.payload + compiled.pkt.headerBytes + (compiled.pkt.gapPs / 1e12) * compiled.bwBps)
      : null;

  return (
    <>
      <Field label="Bus type" hint="A reusable definition in this model. Fields left empty below come from it.">
        <div className="flex gap-1.5">
          <select className="ctl" value={bus.type ?? ''} onChange={(e) => set('type', e.target.value || undefined)}>
            <option value="">None (set every field here)</option>
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name || t.id}
              </option>
            ))}
            {bus.type && !type ? <option value={bus.type}>{bus.type} (missing)</option> : null}
          </select>
          {type ? (
            <button className="btn sm" onClick={() => selectBusType(type.id)}>
              Edit type
            </button>
          ) : null}
        </div>
      </Field>
      {type?.description ? <p className="mb-1 pl-[140px] text-[11.5px] text-muted">{type.description}</p> : null}
      <Field label="Effective">
        <span className="num pt-1 text-ink-2">
          {compiled ? `${fmtRate(compiled.bwBps)}${compiled.duplex ? ' per lane' : ''} · ${compiled.mode === 'packet' ? 'packet level' : 'fluid'}` : '—'}
          {compiled?.mode === 'packet' && Number.isFinite(compiled.pkt.payload) ? ` · ${fmtBytes(compiled.pkt.payload)} packets` : ''}
          {perPacket !== null && perPacket < 1 ? ` · ${(perPacket * 100).toFixed(1)}% payload` : ''}
        </span>
      </Field>
      {type || bus.vars ? (
        <>
          <div className="mt-2 border-t border-line pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted">Variables</div>
          <VarsEditor own={bus.vars ?? {}} inherited={type?.vars ?? {}} scope={scope} allowAdd={!type} set={(v) => set('vars', v)} />
        </>
      ) : null}
      <div className="mt-2 border-t border-line pt-2" />
      <FieldsEditor own={bus} inherited={type ?? null} inheritedLabel={type ? `From ${type.name || type.id}` : 'Default'} scope={scope} set={set} />
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        {overrides.length ? <span className="text-[11.5px] text-muted">Overrides: {overrides.join(', ')}</span> : null}
        <button
          className="btn sm"
          title="Create a bus type from this bus's current settings and switch the bus to it"
          onClick={() => {
            let id: string | null = null;
            update((m) => void (id = saveBusAsType(m, bus.id)));
            if (id) selectBusType(id);
          }}
        >
          Save as new type
        </button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Bus types (inspector list and editor)
// ---------------------------------------------------------------------------

export function BusTypesCard() {
  const model = useStore((s) => s.model);
  const update = useStore((s) => s.update);
  const selectBusType = useStore((s) => s.selectBusType);
  const types = model.busTypes ?? [];
  return (
    <Card
      title="Bus types"
      actions={
        <select
          className="ctl !w-auto"
          value=""
          aria-label="Add bus type"
          onChange={(e) => {
            const v = e.target.value;
            if (!v) return;
            let id = '';
            update((m) => void (id = addBusType(m, v === '__blank' ? null : BUS_TEMPLATES.find((t) => t.id === v) ?? null)));
            selectBusType(id);
          }}
        >
          <option value="">+ Add type…</option>
          <option value="__blank">Blank</option>
          {BUS_TEMPLATES.map((t) => (
            <option key={t.id} value={t.id}>
              From template: {t.name}
            </option>
          ))}
        </select>
      }
    >
      <p className="mb-2 text-ink-2">Reusable bus definitions kept in this model. A bus takes every field it leaves empty from its type.</p>
      {types.length ? (
        <div className="space-y-1">
          {types.map((t) => {
            const users = busTypeUsers(model, t.id);
            return (
              <button key={t.id} className="flex w-full items-center justify-between rounded-md border border-line px-2 py-1.5 text-left hover:bg-surface-2" onClick={() => selectBusType(t.id)}>
                <span>
                  <span className="font-medium">{t.name || t.id}</span> <span className="font-mono text-[11px] text-muted">{t.id}</span>
                </span>
                <span className="text-[11.5px] text-muted">
                  {t.model ?? 'fluid'} · {users.length} bus{users.length === 1 ? '' : 'es'}
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <span className="text-muted">None yet. Add one from a template (AXI4, NoC, PCIe) or start blank.</span>
      )}
    </Card>
  );
}

export function BusTypeEditor({ id }: { id: string }) {
  const model = useStore((s) => s.model);
  const update = useStore((s) => s.update);
  const selectBusType = useStore((s) => s.selectBusType);
  const select = useStore((s) => s.select);
  const c = useCompiled();
  const type = (model.busTypes ?? []).find((t) => t.id === id);
  const scope = useBusScope(type, undefined);
  if (!type) return null;
  const users = busTypeUsers(model, id);
  const edit = (fn: (t: BusTypeSpec) => void, key?: string) =>
    update((m) => {
      const t = (m.busTypes ?? []).find((x) => x.id === id);
      if (t) fn(t);
    }, key && `busType.${id}.${key}`);
  const set = (k: string, v: unknown) =>
    edit((t) => {
      const r = t as unknown as Record<string, unknown>;
      if (v === undefined || v === '') delete r[k];
      else r[k] = v;
    }, k);
  const issues = c.issues.filter((i) => i.path.startsWith(`busTypes.${id}.`));

  return (
    <div className="space-y-3">
      <Card
        title={
          <span>
            {type.name || type.id} <span className="ml-1 font-normal text-muted">Bus type</span>
          </span>
        }
        actions={
          <button className="btn sm ghost" onClick={() => selectBusType(null)}>
            Close
          </button>
        }
      >
        <Field label="Id">
          <IdField
            value={id}
            taken={(model.busTypes ?? []).map((t) => t.id)}
            onCommit={(v) => {
              update((m) => renameBusType(m, id, v));
              selectBusType(v);
            }}
          />
        </Field>
        <Field label="Name">
          <TextField value={type.name ?? ''} placeholder={id} onChange={(v) => set('name', v)} />
        </Field>
        <Field label="Description">
          <textarea className="ctl min-h-[64px]" value={type.description ?? ''} onChange={(e) => set('description', e.target.value)} />
        </Field>
        <div className="mt-2 border-t border-line pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted">Variables</div>
        <p className="mb-1 text-[11.5px] text-muted">Usable in this type's expressions; each bus can override them (e.g. lanes).</p>
        <VarsEditor own={type.vars ?? {}} inherited={{}} scope={scope} allowAdd set={(v) => set('vars', v)} />
        <div className="mt-2 border-t border-line pt-2" />
        <FieldsEditor own={type} inherited={null} inheritedLabel="Default" scope={scope} set={set} />
        {issues.length ? (
          <div className="mt-2 rounded-md bg-critical-wash p-2 text-[12px]">
            {issues.map((i, k) => (
              <div key={k}>{i.message}</div>
            ))}
          </div>
        ) : null}
      </Card>
      <Card title="Used by">
        {users.length ? (
          <div className="flex flex-wrap gap-1">
            {users.map((u) => (
              <button key={u} className="btn sm" onClick={() => select({ kind: 'bus', id: u })}>
                {u}
              </button>
            ))}
          </div>
        ) : (
          <div className="flex items-center justify-between">
            <span className="text-muted">No bus uses this type.</span>
            <button
              className="btn sm"
              onClick={() => {
                update((m) => removeBusType(m, id));
                selectBusType(null);
              }}
            >
              Delete type
            </button>
          </div>
        )}
      </Card>
    </div>
  );
}
