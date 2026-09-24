import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { compileExpr, evalExpr, toBase, toWork, withRng, type Quantity } from '../model/expr';
import type { Expr } from '../model/types';
import { fmtBytes, fmtHz, fmtNum, fmtPct, fmtRate, fmtSeconds } from './format';

export type PreviewKind = Quantity | 'work' | 'none';

/** Evaluates an expression for display: its value in human units, or the error. */
export function preview(value: Expr | undefined, kind: PreviewKind, scope: Record<string, unknown>): { text: string; error: boolean } {
  if (value === undefined || value === '' || kind === 'none') return { text: '', error: false };
  try {
    const v = withRng(null, 'mean', () => evalExpr(compileExpr(value, scope, new Set()), scope));
    switch (kind) {
      case 'time':
        return { text: fmtSeconds(toBase(v, 'time')), error: false };
      case 'bytes':
        return { text: fmtBytes(toBase(v, 'bytes')), error: false };
      case 'freq':
        return { text: fmtHz(toBase(v, 'freq')), error: false };
      case 'bandwidth':
        return { text: fmtRate(toBase(v, 'bandwidth')), error: false };
      case 'count':
        return { text: fmtNum(toBase(v, 'count'), 4), error: false };
      case 'work': {
        const w = toWork(v);
        return { text: 'cycles' in w ? `${fmtNum(w.cycles, 4)} cycles` : fmtSeconds(w.seconds), error: false };
      }
    }
  } catch (e) {
    return { text: (e as Error).message.replace(/^cannot evaluate "[^"]*": /, ''), error: true };
  }
}

/**
 * A text field for a mathjs expression with a live evaluation underneath. Edits are
 * committed as the user types; numbers stay numbers so the YAML stays clean.
 */
export function ExprField({
  value,
  onChange,
  kind,
  scope,
  placeholder,
  optional,
  mono = true,
}: {
  value: Expr | undefined;
  onChange: (v: Expr | undefined) => void;
  kind: PreviewKind;
  scope: Record<string, unknown>;
  placeholder?: string;
  optional?: boolean;
  mono?: boolean;
}) {
  const [text, setText] = useState(value === undefined ? '' : String(value));
  useEffect(() => {
    const incoming = value === undefined ? '' : String(value);
    setText((cur) => (normalize(cur) === normalize(incoming) ? cur : incoming));
  }, [value]);
  const p = useMemo(() => preview(value, kind, scope), [value, kind, scope]);
  const showPreview = p.text && !(typeof value === 'number' && kind === 'count');
  return (
    <div className="min-w-0">
      <input
        className={`ctl ${mono ? 'font-mono text-[12px]' : ''} ${p.error ? 'bad' : ''}`}
        value={text}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value);
          const t = e.target.value.trim();
          if (t === '') onChange(optional ? undefined : '');
          else if (/^-?\d+(\.\d+)?(e[-+]?\d+)?$/i.test(t)) onChange(Number(t));
          else onChange(e.target.value);
        }}
      />
      {showPreview ? (
        <div className={`mt-0.5 truncate text-[11px] ${p.error ? 'text-critical' : 'text-muted'}`} title={p.text}>
          {p.error ? '⚠ ' : '= '}
          {p.text}
        </div>
      ) : null}
    </div>
  );
}

const normalize = (s: string) => s.trim();

export function TextField({ value, onChange, placeholder, mono }: { value: string; onChange: (v: string) => void; placeholder?: string; mono?: boolean }) {
  return (
    <input
      className={`ctl ${mono ? 'font-mono text-[12px]' : ''}`}
      value={value}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/** An id field that only commits valid, unused identifiers (on blur or Enter). */
export function IdField({ value, taken, onCommit }: { value: string; taken: string[]; onCommit: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const valid = /^[A-Za-z_][A-Za-z0-9_-]*$/.test(text);
  const clash = text !== value && taken.includes(text);
  const commit = () => {
    if (valid && !clash && text !== value) onCommit(text);
    else setText(value);
  };
  return (
    <div>
      <input
        className={`ctl font-mono text-[12px] ${!valid || clash ? 'bad' : ''}`}
        value={text}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') setText(value);
        }}
      />
      {!valid ? <div className="mt-0.5 text-[11px] text-critical">letters, digits, _ and -</div> : clash ? <div className="mt-0.5 text-[11px] text-critical">already used</div> : null}
    </div>
  );
}

export function Select<T extends string>({
  value,
  options,
  onChange,
  className = '',
}: {
  value: T;
  options: { value: T; label: string }[] | readonly T[];
  onChange: (v: T) => void;
  className?: string;
}) {
  const opts = options.map((o) => (typeof o === 'string' ? { value: o, label: o } : o));
  return (
    <select className={`ctl ${className}`} value={value} onChange={(e) => onChange(e.target.value as T)}>
      {!opts.some((o) => o.value === value) ? <option value={value}>{value || '—'}</option> : null}
      {opts.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="grid grid-cols-[132px_1fr] items-start gap-2 py-1">
      <span className="pt-1 text-[12px] text-ink-2" title={hint}>
        {label}
        {hint ? <span className="ml-1 cursor-help text-muted">ⓘ</span> : null}
      </span>
      <span className="min-w-0">{children}</span>
    </label>
  );
}

export function Card({ title, actions, children, className = '', pad = true }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; pad?: boolean }) {
  return (
    <section className={`rounded-lg border border-line bg-surface ${className}`}>
      {title || actions ? (
        <header className="flex min-h-[38px] items-center justify-between gap-2 border-b border-line px-3 py-1.5">
          <h3 className="text-[13px] font-semibold">{title}</h3>
          <div className="flex items-center gap-1.5">{actions}</div>
        </header>
      ) : null}
      <div className={pad ? 'p-3' : ''}>{children}</div>
    </section>
  );
}

/** Utilization meter: the fill carries severity; the track is a light wash of the same hue. */
export function UtilBar({ value, width = 120, showLabel = true }: { value: number; width?: number; showLabel?: boolean }) {
  const v = Math.max(0, value);
  const color = v >= 0.9 ? 'var(--critical)' : v >= 0.7 ? 'var(--warning)' : 'var(--accent)';
  return (
    <span className="inline-flex items-center gap-2">
      <span className="relative inline-block h-[8px] overflow-hidden rounded-full" style={{ width, background: 'var(--surface-3)' }}>
        <span className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${Math.min(1, v) * 100}%`, background: color }} />
      </span>
      {showLabel ? <span className="num w-[52px] text-right">{fmtPct(v)}</span> : null}
    </span>
  );
}

export function Tile({ label, value, sub, status }: { label: string; value: ReactNode; sub?: ReactNode; status?: 'good' | 'bad' | 'warn' }) {
  const icon = status === 'good' ? '✓' : status === 'bad' ? '✕' : status === 'warn' ? '!' : null;
  const color = status === 'good' ? 'var(--good)' : status === 'bad' ? 'var(--critical)' : 'var(--warning)';
  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-2.5">
      <div className="text-[12px] text-ink-2">{label}</div>
      <div className="mt-0.5 flex items-center gap-2 text-[22px] font-semibold leading-tight">
        {icon ? (
          <span className="inline-flex h-[18px] w-[18px] items-center justify-center rounded-full text-[11px] text-white" style={{ background: color }}>
            {icon}
          </span>
        ) : null}
        {value}
      </div>
      {sub ? <div className="mt-0.5 text-[12px] text-muted">{sub}</div> : null}
    </div>
  );
}

export function Status({ ok, text }: { ok: boolean | 'warn'; text: string }) {
  const color = ok === true ? 'var(--good)' : ok === 'warn' ? 'var(--warning)' : 'var(--critical)';
  const icon = ok === true ? '✓' : ok === 'warn' ? '!' : '✕';
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span className="inline-flex h-[14px] w-[14px] items-center justify-center rounded-full text-[9px] font-bold text-white" style={{ background: color }}>
        {icon}
      </span>
      {text}
    </span>
  );
}

export function Swatch({ color, shape = 'square' }: { color: string; shape?: 'square' | 'line' }) {
  return shape === 'line' ? (
    <span className="inline-block h-[2px] w-[12px] rounded" style={{ background: color }} />
  ) : (
    <span className="inline-block h-[10px] w-[10px] shrink-0 rounded-[3px]" style={{ background: color }} />
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex h-full min-h-[240px] flex-col items-center justify-center gap-2 p-8 text-center">
      <div className="text-[15px] font-semibold">{title}</div>
      <div className="max-w-[460px] text-ink-2">{children}</div>
    </div>
  );
}

export function Checkbox({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-1.5 py-1">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="accent-[var(--accent)]" />
      <span>{label}</span>
    </label>
  );
}
