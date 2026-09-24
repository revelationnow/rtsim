import type { WorkerRequest, WorkerResponse } from '../sim/worker';

type Req = WorkerRequest extends infer R ? (R extends WorkerRequest ? Omit<R, 'id'> : never) : never;

declare const __SINGLE_FILE__: boolean;

let worker: Worker | null = null;
let workerFailed = false;
let nextId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; progress?: (f: number, l?: string) => void }>();

async function getWorker(): Promise<Worker | null> {
  if (worker || workerFailed) return worker;
  try {
    // The single-file build inlines the worker as a blob; the normal build loads a chunk.
    if (__SINGLE_FILE__) {
      const mod = await import('../sim/worker.ts?worker&inline');
      worker = new mod.default();
    } else {
      worker = new Worker(new URL('../sim/worker.ts', import.meta.url), { type: 'module' });
    }
    worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const msg = ev.data;
      const p = pending.get(msg.id);
      if (!p) return;
      if (msg.type === 'progress') p.progress?.(msg.fraction, msg.label);
      else {
        pending.delete(msg.id);
        if (msg.type === 'done') p.resolve(msg.payload);
        else p.reject(new Error(msg.message));
      }
    };
    worker.onerror = () => {
      // A worker that cannot start (e.g. blocked by a sandbox) falls back to the main thread.
      workerFailed = true;
      worker = null;
      for (const [id, p] of pending) {
        pending.delete(id);
        p.reject(new Error('__retry__'));
      }
    };
  } catch {
    workerFailed = true;
    worker = null;
  }
  return worker;
}

async function runInline<T>(req: WorkerRequest, progress?: (f: number, l?: string) => void): Promise<T> {
  const { handle } = await import('../sim/worker');
  // Yield once so the UI can paint the "running" state before the main thread is busy.
  await new Promise((r) => setTimeout(r, 30));
  return new Promise<T>((resolve, reject) => {
    handle(req, (msg) => {
      if (msg.type === 'progress') progress?.(msg.fraction, msg.label);
      else if (msg.type === 'done') resolve(msg.payload as T);
      else reject(new Error(msg.message));
    });
  });
}

/** Runs a request in the simulation worker (or inline if workers are unavailable). */
export async function request<T>(req: Req, progress?: (f: number, l?: string) => void): Promise<T> {
  const id = nextId++;
  const full = { ...req, id } as WorkerRequest;
  const w = await getWorker();
  if (!w) return runInline<T>(full, progress);
  try {
    return await new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject, progress });
      w.postMessage(full);
    });
  } catch (e) {
    if ((e as Error).message === '__retry__') return runInline<T>(full, progress);
    throw e;
  }
}

/** Abandons whatever is running by restarting the worker. */
export function cancelAll(): void {
  if (worker) {
    worker.terminate();
    worker = null;
  }
  for (const [id, p] of pending) {
    pending.delete(id);
    p.reject(new Error('Cancelled'));
  }
}
