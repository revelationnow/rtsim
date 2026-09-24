/// <reference lib="webworker" />
import type { Model } from '../model/types';
import { runModel } from './simulate';
import { runSweep, solve, type SolveSpec, type SweepSpec } from './sweep';

export type WorkerRequest =
  | { id: number; type: 'run'; model: Model }
  | { id: number; type: 'sweep'; model: Model; spec: SweepSpec }
  | { id: number; type: 'solve'; model: Model; spec: SolveSpec };

export type WorkerResponse =
  | { id: number; type: 'progress'; fraction: number; label?: string }
  | { id: number; type: 'done'; payload: unknown }
  | { id: number; type: 'error'; message: string };

export function handle(req: WorkerRequest, post: (msg: WorkerResponse) => void): void {
  const progress = (fraction: number, label?: string) => post({ id: req.id, type: 'progress', fraction, label });
  try {
    let payload: unknown;
    if (req.type === 'run') payload = runModel(req.model, { onProgress: (f) => progress(f) });
    else if (req.type === 'sweep') payload = runSweep(req.model, req.spec, (d, n) => progress(d / n, `${d}/${n} runs`));
    else payload = solve(req.model, req.spec, (d, n) => progress(Math.min(0.99, d / n), `trial ${d}`));
    post({ id: req.id, type: 'done', payload });
  } catch (e) {
    post({ id: req.id, type: 'error', message: (e as Error).message });
  }
}

// Only wire up message handling when actually running as a worker.
if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
  self.onmessage = (ev: MessageEvent<WorkerRequest>) => handle(ev.data, (m) => self.postMessage(m));
}
