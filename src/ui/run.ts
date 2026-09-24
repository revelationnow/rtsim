import { analyze } from '../sim/analysis';
import type { SimFailure, SimResult } from '../sim/result';
import type { SolveResult, SolveSpec, SweepPoint, SweepSpec } from '../sim/sweep';
import { compiled } from './hooks';
import { cancelAll, request } from './simClient';
import { useStore } from './store';

export async function runSimulation(): Promise<void> {
  const { model, setRun, run } = useStore.getState();
  if (run.status === 'running') return;
  const c = compiled(model);
  if (!c.ok) {
    setRun({ status: 'error', error: 'The model has errors — fix them before running.', issues: c.issues });
    return;
  }
  setRun({ status: 'running', progress: 0, label: undefined, error: undefined, issues: undefined });
  try {
    const res = await request<SimResult | SimFailure>({ type: 'run', model }, (f) => useStore.getState().setRun({ progress: f }));
    if (res.ok) {
      setRun({ status: 'done', progress: 1, result: res, ranModel: model });
      const view = useStore.getState().view;
      if (view !== 'results' && view !== 'timeline') useStore.getState().setView('results');
    } else setRun({ status: 'error', error: res.error, issues: res.issues });
  } catch (e) {
    setRun({ status: 'error', error: (e as Error).message });
  }
}

export function cancelRun(): void {
  cancelAll();
  const s = useStore.getState();
  if (s.run.status === 'running') s.setRun({ status: s.run.result ? 'done' : 'idle', progress: 0 });
  if (s.sweep.status === 'running') s.setSweep({ status: 'idle', progress: 0 });
}

export function refreshAnalysis(): void {
  const { model, setAnalysis } = useStore.getState();
  const c = compiled(model);
  setAnalysis(c.ok ? analyze(c.model) : null);
}

export async function runSweep(spec: SweepSpec): Promise<void> {
  const { model, setSweep } = useStore.getState();
  setSweep({ status: 'running', progress: 0, label: undefined, error: undefined, solve: undefined, param: spec.param });
  try {
    const points = await request<SweepPoint[]>({ type: 'sweep', model, spec }, (f, label) => useStore.getState().setSweep({ progress: f, label }));
    setSweep({ status: 'done', points, progress: 1 });
  } catch (e) {
    setSweep({ status: 'error', error: (e as Error).message });
  }
}

export async function runSolve(spec: SolveSpec): Promise<void> {
  const { model, setSweep } = useStore.getState();
  setSweep({ status: 'running', progress: 0, label: undefined, error: undefined, solve: undefined, param: spec.param });
  try {
    const solve = await request<SolveResult>({ type: 'solve', model, spec }, (f, label) => useStore.getState().setSweep({ progress: f, label }));
    setSweep({ status: 'done', solve, progress: 1 });
  } catch (e) {
    setSweep({ status: 'error', error: (e as Error).message });
  }
}
