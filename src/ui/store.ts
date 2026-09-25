import { create } from 'zustand';
import { adas } from '../examples';
import { normalizeModel } from '../model/io';
import type { Issue } from '../model/compile';
import type { ComponentKind, Model } from '../model/types';
import type { Analysis } from '../sim/analysis';
import type { SimResult } from '../sim/result';
import type { SolveResult, SweepPoint } from '../sim/sweep';

export type View = 'architecture' | 'workplans' | 'params' | 'source' | 'requirements' | 'results' | 'timeline' | 'sweep';
export type Theme = 'system' | 'light' | 'dark';

export interface RunState {
  status: 'idle' | 'running' | 'done' | 'error';
  progress: number;
  label?: string;
  result?: SimResult;
  error?: string;
  issues?: Issue[];
  /** The model as it was when the current result was produced. */
  ranModel?: Model;
}

export interface SweepState {
  status: 'idle' | 'running' | 'done' | 'error';
  progress: number;
  label?: string;
  param: string;
  points?: SweepPoint[];
  solve?: SolveResult;
  error?: string;
}

interface Store {
  model: Model;
  past: Model[];
  future: Model[];
  lastKey: string | null;
  lastAt: number;
  update: (fn: (draft: Model) => void, key?: string) => void;
  replace: (model: Model) => void;
  undo: () => void;
  redo: () => void;

  view: View;
  setView: (v: View) => void;
  selection: { kind: ComponentKind; id: string } | null;
  select: (s: { kind: ComponentKind; id: string } | null) => void;
  selectedWp: string | null;
  selectWp: (id: string | null) => void;
  /** Bus type open in the architecture inspector. */
  selectedBusType: string | null;
  selectBusType: (id: string | null) => void;
  focusJob: { wp: string; job: number } | null;
  setFocusJob: (f: { wp: string; job: number } | null) => void;

  run: RunState;
  setRun: (r: Partial<RunState>) => void;
  sweep: SweepState;
  setSweep: (s: Partial<SweepState>) => void;
  analysis: Analysis | null;
  setAnalysis: (a: Analysis | null) => void;

  theme: Theme;
  setTheme: (t: Theme) => void;
}

const MODEL_KEY = 'rtsim.model.v1';
const THEME_KEY = 'rtsim.theme';

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage may be unavailable (private mode, sandbox); the app works without it */
  }
}

const HISTORY = 200;

/** The autosaved model, brought up to date with the current schema; the example if none. */
function loadModel(): Model {
  try {
    const saved = load<unknown>(MODEL_KEY, null);
    if (saved) return normalizeModel(saved);
  } catch {
    /* an unreadable save falls back to the example */
  }
  return structuredClone(adas);
}

export const useStore = create<Store>((set, get) => ({
  model: loadModel(),
  past: [],
  future: [],
  lastKey: null,
  lastAt: 0,
  update: (fn, key) => {
    const { model, past, lastKey, lastAt } = get();
    const draft = structuredClone(model);
    fn(draft);
    const now = Date.now();
    // Consecutive edits to the same field (typing) collapse into one undo step.
    const coalesce = key !== undefined && key === lastKey && now - lastAt < 1500;
    set({
      model: draft,
      past: coalesce ? past : [...past, model].slice(-HISTORY),
      future: [],
      lastKey: key ?? null,
      lastAt: now,
    });
  },
  replace: (model) => {
    const { model: cur, past } = get();
    set({ model: structuredClone(model), past: [...past, cur].slice(-HISTORY), future: [], lastKey: null });
  },
  undo: () => {
    const { past, model, future } = get();
    if (!past.length) return;
    set({ model: past[past.length - 1], past: past.slice(0, -1), future: [model, ...future], lastKey: null });
  },
  redo: () => {
    const { past, model, future } = get();
    if (!future.length) return;
    set({ model: future[0], past: [...past, model], future: future.slice(1), lastKey: null });
  },

  view: 'architecture',
  setView: (view) => set({ view }),
  selection: null,
  select: (selection) => set({ selection, selectedBusType: selection ? null : get().selectedBusType }),
  selectedWp: null,
  selectWp: (selectedWp) => set({ selectedWp }),
  selectedBusType: null,
  selectBusType: (selectedBusType) => set({ selectedBusType, selection: selectedBusType ? null : get().selection }),
  focusJob: null,
  setFocusJob: (focusJob) => set({ focusJob }),

  run: { status: 'idle', progress: 0 },
  setRun: (r) => set({ run: { ...get().run, ...r } }),
  sweep: { status: 'idle', progress: 0, param: '' },
  setSweep: (s) => set({ sweep: { ...get().sweep, ...s } }),
  analysis: null,
  setAnalysis: (analysis) => set({ analysis }),

  theme: load<Theme>(THEME_KEY, 'system'),
  setTheme: (theme) => {
    save(THEME_KEY, theme);
    set({ theme });
  },
}));

let saveTimer: ReturnType<typeof setTimeout> | undefined;
useStore.subscribe((s, prev) => {
  if (s.model !== prev.model) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => save(MODEL_KEY, s.model), 400);
  }
});
