import { useEffect, useMemo, useState } from 'react';
import { compile, type CompileResult } from '../model/compile';
import { evalExpr, compileExpr, withRng } from '../model/expr';
import type { Model } from '../model/types';
import { useStore } from './store';

let memo: { model: Model | null; result: CompileResult | null } = { model: null, result: null };

/** Compiles the current model once per change, shared by every component that asks. */
export function compiled(model: Model): CompileResult {
  if (memo.model !== model) memo = { model, result: compile(model) };
  return memo.result!;
}

export function useCompiled(): CompileResult {
  const model = useStore((s) => s.model);
  return compiled(model);
}

/** Evaluated params (by value) even when other parts of the model have errors. */
export function useParamScope(): Record<string, unknown> {
  const params = useStore((s) => s.model.params);
  return useMemo(() => {
    const scope: Record<string, unknown> = {};
    for (const [k, e] of Object.entries(params ?? {})) {
      try {
        scope[k] = withRng(null, 'mean', () => evalExpr(compileExpr(e, scope, new Set()), scope));
      } catch {
        /* reported by the compiler */
      }
    }
    return scope;
  }, [params]);
}

/** Scope for previewing a step expression: params + the workplan's vars at their means. */
export function useStepScope(wpId: string | null): Record<string, unknown> {
  const params = useParamScope();
  const wp = useStore((s) => s.model.workplans.find((w) => w.id === wpId));
  return useMemo(() => {
    const scope: Record<string, unknown> = { ...params, job: 0, t: 0, in_bytes: 0 };
    for (const [k, e] of Object.entries(wp?.vars ?? {})) {
      try {
        scope[k] = withRng(null, 'mean', () => evalExpr(compileExpr(e, scope, new Set()), scope));
      } catch {
        /* shown on the field */
      }
    }
    return scope;
  }, [params, wp?.vars]);
}

/** Resolves the CSS color tokens to concrete values for canvas drawing; updates with the theme. */
export function useCssColors(): Record<string, string> {
  const theme = useStore((s) => s.theme);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const on = () => setTick((t) => t + 1);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return useMemo(() => {
    const cs = getComputedStyle(document.documentElement);
    const names = [
      'page', 'surface', 'surface-2', 'surface-3', 'line', 'line-strong', 'ink', 'ink-2', 'muted', 'grid', 'axis',
      'accent', 'accent-wash', 'good', 'warning', 'serious', 'critical', 'critical-wash',
      'series-1', 'series-2', 'series-3', 'series-4', 'series-5', 'series-6', 'series-7', 'series-8',
      'seq-100', 'seq-300', 'seq-500', 'seq-700',
    ];
    const out: Record<string, string> = {};
    for (const n of names) out[n] = cs.getPropertyValue(`--${n}`).trim();
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme, tick]);
}

/** Categorical slot for a workplan index — assigned in fixed order; beyond 8 falls back to gray. */
export function seriesVar(i: number): string {
  return i < 8 ? `var(--series-${i + 1})` : 'var(--muted)';
}

export function seriesKey(i: number): string {
  return i < 8 ? `series-${i + 1}` : 'muted';
}
