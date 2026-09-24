import { useEffect, useRef, useState } from 'react';
import { EXAMPLES } from './examples';
import { parseModelText, toYaml } from './model/io';
import { ExprField } from './ui/components';
import { useCompiled, useParamScope } from './ui/hooks';
import { cancelRun, runSimulation } from './ui/run';
import { useStore, type View } from './ui/store';
import { ArchitectureView } from './views/ArchitectureView';
import { ParamsView } from './views/ParamsView';
import { RequirementsView } from './views/RequirementsView';
import { ResultsView } from './views/ResultsView';
import { SourceView } from './views/SourceView';
import { SweepView } from './views/SweepView';
import { TimelineView } from './views/TimelineView';
import { WorkplansView } from './views/WorkplansView';

const NAV: { group: string; items: { id: View; label: string; hint: string }[] }[] = [
  {
    group: 'Model',
    items: [
      { id: 'architecture', label: 'Architecture', hint: 'Processors, memories, buses, DMA and how they connect' },
      { id: 'workplans', label: 'Workplans', hint: 'Triggered task graphs of compute, transfers and delays' },
      { id: 'params', label: 'Parameters', hint: 'Named values used in expressions and sweeps' },
      { id: 'source', label: 'Source', hint: 'The whole model as YAML' },
    ],
  },
  {
    group: 'Analyze',
    items: [
      { id: 'requirements', label: 'Requirements', hint: 'Average demand vs capacity and latency lower bounds' },
      { id: 'results', label: 'Results', hint: 'Deadlines, latency distributions and utilization from the last run' },
      { id: 'timeline', label: 'Timeline', hint: 'Gantt view of every job, core and transfer' },
      { id: 'sweep', label: 'Sweep & solve', hint: 'Vary a parameter; solve for the minimum that meets deadlines' },
    ],
  },
];

export function App() {
  const view = useStore((s) => s.view);
  const theme = useStore((s) => s.theme);

  useEffect(() => {
    if (theme === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        void runSimulation();
        return;
      }
      const editing = (e.target as HTMLElement)?.closest('input, textarea, select');
      if (editing) return;
      if (e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) useStore.getState().redo();
        else useStore.getState().undo();
      } else if (e.key.toLowerCase() === 'y') {
        e.preventDefault();
        useStore.getState().redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="flex h-full flex-col">
      <Header />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="min-w-0 flex-1 overflow-auto">
          {view === 'architecture' && <ArchitectureView />}
          {view === 'workplans' && <WorkplansView />}
          {view === 'params' && <ParamsView />}
          {view === 'source' && <SourceView />}
          {view === 'requirements' && <RequirementsView />}
          {view === 'results' && <ResultsView />}
          {view === 'timeline' && <TimelineView />}
          {view === 'sweep' && <SweepView />}
        </main>
      </div>
    </div>
  );
}

function Header() {
  const model = useStore((s) => s.model);
  const update = useStore((s) => s.update);
  const replace = useStore((s) => s.replace);
  const { past, future, undo, redo, theme, setTheme } = useStore();
  const fileRef = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const download = (name: string, text: string, type: string) => {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const slug = model.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'model';

  return (
    <header className="flex h-[48px] shrink-0 items-center gap-3 border-b border-line bg-surface px-3">
      <div className="flex items-center gap-2">
        <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden>
          <rect width="32" height="32" rx="7" fill="var(--accent)" />
          <path d="M6 22h5v-8h5v12h5V8h5" stroke="white" strokeWidth="2.6" fill="none" strokeLinejoin="round" strokeLinecap="round" />
        </svg>
        <span className="text-[14px] font-semibold tracking-tight">RTSim</span>
      </div>
      <input
        className="ctl max-w-[320px] !border-transparent bg-transparent font-medium hover:!border-[var(--line-strong)]"
        value={model.name}
        onChange={(e) => update((m) => void (m.name = e.target.value), 'name')}
        aria-label="Model name"
      />
      <div className="flex items-center gap-1">
        <select
          className="ctl !w-[118px]"
          value=""
          onChange={(e) => {
            const ex = EXAMPLES.find((x) => x.key === e.target.value);
            if (ex) {
              replace(ex.model);
              useStore.getState().setRun({ status: 'idle', result: undefined, progress: 0 });
            }
          }}
          aria-label="Load example"
        >
          <option value="">Examples…</option>
          {EXAMPLES.map((x) => (
            <option key={x.key} value={x.key}>
              {x.model.name}
            </option>
          ))}
        </select>
        <button className="btn ghost" onClick={() => fileRef.current?.click()} title="Open a YAML or JSON model">
          Open
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".yaml,.yml,.json,text/yaml,application/json"
          className="hidden"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f) return;
            try {
              replace(parseModelText(await f.text()));
              useStore.getState().setRun({ status: 'idle', result: undefined, progress: 0 });
              setMsg(`Loaded ${f.name}`);
            } catch (err) {
              setMsg(`Could not load ${f.name}: ${(err as Error).message}`);
            }
            setTimeout(() => setMsg(null), 4000);
          }}
        />
        <button className="btn ghost" onClick={() => download(`${slug}.yaml`, toYaml(model), 'text/yaml')} title="Download the model as YAML">
          Save YAML
        </button>
        <button className="btn ghost" onClick={() => download(`${slug}.json`, JSON.stringify(model, null, 2), 'application/json')} title="Download the model as JSON">
          JSON
        </button>
        <span className="mx-1 h-5 w-px bg-[var(--line)]" />
        <button className="btn ghost" disabled={!past.length} onClick={undo} title="Undo (Ctrl/Cmd+Z)">
          ↶
        </button>
        <button className="btn ghost" disabled={!future.length} onClick={redo} title="Redo (Ctrl/Cmd+Shift+Z)">
          ↷
        </button>
      </div>
      {msg ? <span className="truncate text-[12px] text-ink-2">{msg}</span> : null}
      <div className="flex-1" />
      <select className="ctl !w-auto" value={theme} onChange={(e) => setTheme(e.target.value as typeof theme)} aria-label="Theme">
        <option value="system">System theme</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
      <RunControls />
    </header>
  );
}

function RunControls() {
  const sim = useStore((s) => s.model.sim);
  const update = useStore((s) => s.update);
  const run = useStore((s) => s.run);
  const c = useCompiled();
  const scope = useParamScope();
  const errors = c.ok ? 0 : c.issues.filter((i) => i.severity === 'error').length;
  const running = run.status === 'running';
  return (
    <div className="flex items-center gap-2">
      <div className="flex items-center gap-1.5">
        <span className="text-[12px] text-ink-2">Simulate</span>
        <div className="w-[92px]">
          <ExprField value={sim.duration} kind="none" scope={scope} onChange={(v) => update((m) => void (m.sim.duration = v ?? ''), 'sim.duration')} />
        </div>
        <span className="text-[12px] text-ink-2">seed</span>
        <input
          className="ctl num !w-[58px]"
          type="number"
          value={sim.seed ?? 1}
          onChange={(e) => update((m) => void (m.sim.seed = Number(e.target.value) || 0), 'sim.seed')}
          aria-label="Random seed"
        />
      </div>
      {running ? (
        <>
          <span className="num w-[44px] text-right text-[12px] text-ink-2">{Math.round(run.progress * 100)}%</span>
          <button className="btn" onClick={cancelRun}>
            Cancel
          </button>
        </>
      ) : (
        <button
          className="btn primary"
          onClick={() => void runSimulation()}
          disabled={errors > 0}
          title={errors ? `${errors} model error${errors > 1 ? 's' : ''} — see the issues panel` : 'Run (Ctrl/Cmd+Enter)'}
        >
          ▶ Run
        </button>
      )}
    </div>
  );
}

function Sidebar() {
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const run = useStore((s) => s.run);
  const model = useStore((s) => s.model);
  const c = useCompiled();
  const issues = c.issues;
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  const misses = run.result?.workplans.reduce((a, w) => a + w.missed + w.skipped, 0) ?? 0;
  const stale = run.result && run.ranModel !== model;
  const [open, setOpen] = useState(true);

  return (
    <nav className="flex w-[208px] shrink-0 flex-col border-r border-line bg-surface">
      <div className="flex-1 overflow-auto p-2">
        {NAV.map((g) => (
          <div key={g.group} className="mb-3">
            <div className="px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted">{g.group}</div>
            {g.items.map((it) => {
              const active = view === it.id;
              let badge: React.ReactNode = null;
              if (it.id === 'results' && run.result) {
                badge = misses ? (
                  <span className="rounded-full bg-critical px-1.5 text-[11px] font-semibold text-white">{misses}</span>
                ) : (
                  <span className="text-[11px] text-good-ink">✓</span>
                );
              }
              return (
                <button
                  key={it.id}
                  title={it.hint}
                  onClick={() => setView(it.id)}
                  className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left ${active ? 'bg-accent-wash font-semibold text-ink' : 'text-ink-2 hover:bg-surface-2'}`}
                >
                  <span>{it.label}</span>
                  {badge}
                </button>
              );
            })}
          </div>
        ))}
        {stale ? <div className="mx-2 rounded-md bg-surface-2 p-2 text-[12px] text-ink-2">The model changed since the last run. Results show the previous run.</div> : null}
        {run.status === 'error' ? (
          <div className="mx-2 mt-2 rounded-md bg-critical-wash p-2 text-[12px]">
            <div className="font-semibold">Run failed</div>
            <div className="text-ink-2">{run.error}</div>
          </div>
        ) : null}
      </div>
      <div className="border-t border-line">
        <button className="flex w-full items-center justify-between px-3 py-2 text-left text-[12px]" onClick={() => setOpen(!open)}>
          <span className="font-semibold">
            {errors.length ? <span className="text-critical">{errors.length} error{errors.length > 1 ? 's' : ''}</span> : <span className="text-good-ink">✓ Model valid</span>}
            {warnings.length ? <span className="ml-2 text-ink-2">{warnings.length} warning{warnings.length > 1 ? 's' : ''}</span> : null}
          </span>
          <span className="text-muted">{open ? '▾' : '▸'}</span>
        </button>
        {open && issues.length ? (
          <ul className="max-h-[220px] overflow-auto px-3 pb-2 text-[11.5px]">
            {issues.map((i, k) => (
              <li key={k} className="border-t border-line py-1.5">
                <div className={`font-mono ${i.severity === 'error' ? 'text-critical' : 'text-ink-2'}`}>{i.path}</div>
                <div className="text-ink-2">{i.message}</div>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </nav>
  );
}
