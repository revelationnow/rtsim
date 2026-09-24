import type { ComponentKind, Model, StepSpec, WorkplanSpec } from './types';

/** Mutating helpers used on a cloned draft; they keep cross-references consistent. */

export function allComponentIds(m: Model): string[] {
  return [
    ...m.processors.map((x) => x.id),
    ...m.memories.map((x) => x.id),
    ...m.buses.map((x) => x.id),
    ...(m.dmas ?? []).map((x) => x.id),
  ];
}

export function uniqueId(prefix: string, taken: Iterable<string>): string {
  const set = new Set(taken);
  if (!set.has(prefix)) return prefix;
  for (let i = 2; ; i++) if (!set.has(`${prefix}${i}`)) return `${prefix}${i}`;
}

export function kindOf(m: Model, id: string): ComponentKind | null {
  if (m.processors.some((x) => x.id === id)) return 'processor';
  if (m.memories.some((x) => x.id === id)) return 'memory';
  if (m.buses.some((x) => x.id === id)) return 'bus';
  if ((m.dmas ?? []).some((x) => x.id === id)) return 'dma';
  return null;
}

export function listOf(m: Model, kind: ComponentKind): { id: string }[] {
  switch (kind) {
    case 'processor':
      return m.processors;
    case 'memory':
      return m.memories;
    case 'bus':
      return m.buses;
    case 'dma':
      return (m.dmas ??= []);
  }
}

export function addComponent(m: Model, kind: ComponentKind): string {
  const id = uniqueId({ processor: 'cpu', memory: 'mem', bus: 'bus', dma: 'dma' }[kind], allComponentIds(m));
  switch (kind) {
    case 'processor':
      m.processors.push({ id, freq: '1 GHz', cores: 1, policy: 'fifo' });
      break;
    case 'memory':
      m.memories.push({ id, size: '1 MiB', bandwidth: '16 GB/s', readLatency: '10 ns' });
      break;
    case 'bus':
      m.buses.push({ id, width: '128 bit', freq: '500 MHz', latency: '10 ns' });
      break;
    case 'dma':
      (m.dmas ??= []).push({ id, channels: 2 });
      break;
  }
  return id;
}

function eachStep(m: Model, fn: (s: StepSpec, w: WorkplanSpec) => void) {
  for (const w of m.workplans) for (const s of w.steps) fn(s, w);
}

export function renameComponent(m: Model, from: string, to: string): void {
  if (from === to) return;
  const comp = [...m.processors, ...m.memories, ...m.buses, ...(m.dmas ?? [])].find((c) => c.id === from);
  if (comp) comp.id = to;
  m.links = m.links.map(([a, b]) => [a === from ? to : a, b === from ? to : b]);
  eachStep(m, (s) => {
    if (s.kind === 'compute' && s.on === from) s.on = to;
    if (s.kind === 'transfer') {
      if (s.from === from) s.from = to;
      if (s.to === from) s.to = to;
      if (s.via === from) s.via = to;
    }
  });
  if (m.layout?.[from]) {
    m.layout[to] = m.layout[from];
    delete m.layout[from];
  }
}

export function removeComponent(m: Model, id: string): void {
  m.processors = m.processors.filter((x) => x.id !== id);
  m.memories = m.memories.filter((x) => x.id !== id);
  m.buses = m.buses.filter((x) => x.id !== id);
  m.dmas = (m.dmas ?? []).filter((x) => x.id !== id);
  m.links = m.links.filter(([a, b]) => a !== id && b !== id);
  if (m.layout) delete m.layout[id];
}

export function hasLink(m: Model, a: string, b: string): boolean {
  return m.links.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
}

export function renameWorkplan(m: Model, from: string, to: string): void {
  const w = m.workplans.find((x) => x.id === from);
  if (!w || from === to) return;
  w.id = to;
  for (const other of m.workplans) {
    const t = other.trigger;
    if (t.type === 'event') {
      t.sources = t.sources.map((s) => {
        const [wp, step] = s.split('.');
        return wp === from ? (step ? `${to}.${step}` : to) : s;
      });
    }
  }
  if (m.layout) {
    for (const k of Object.keys(m.layout)) {
      if (k.startsWith(`${from}/`)) {
        m.layout[`${to}/${k.slice(from.length + 1)}`] = m.layout[k];
        delete m.layout[k];
      }
    }
  }
}

export function removeWorkplan(m: Model, id: string): void {
  m.workplans = m.workplans.filter((w) => w.id !== id);
  for (const other of m.workplans) {
    const t = other.trigger;
    if (t.type === 'event') t.sources = t.sources.filter((s) => s.split('.')[0] !== id);
  }
}

export function renameStep(m: Model, wpId: string, from: string, to: string): void {
  const w = m.workplans.find((x) => x.id === wpId);
  if (!w || from === to) return;
  for (const s of w.steps) {
    if (s.id === from) s.id = to;
    if (s.after) s.after = s.after.map((a) => (a === from ? to : a));
  }
  for (const other of m.workplans) {
    const t = other.trigger;
    if (t.type === 'event') t.sources = t.sources.map((s) => (s === `${wpId}.${from}` ? `${wpId}.${to}` : s));
  }
  if (m.layout?.[`${wpId}/${from}`]) {
    m.layout[`${wpId}/${to}`] = m.layout[`${wpId}/${from}`];
    delete m.layout[`${wpId}/${from}`];
  }
}

export function removeStep(m: Model, wpId: string, id: string): void {
  const w = m.workplans.find((x) => x.id === wpId);
  if (!w) return;
  const removed = w.steps.find((s) => s.id === id);
  w.steps = w.steps.filter((s) => s.id !== id);
  // Bridge the gap: successors inherit the removed step's own dependencies.
  for (const s of w.steps) {
    if (s.after?.includes(id)) {
      s.after = [...new Set([...s.after.filter((a) => a !== id), ...(removed?.after ?? [])])];
    }
  }
  for (const other of m.workplans) {
    const t = other.trigger;
    if (t.type === 'event') t.sources = t.sources.filter((s) => s !== `${wpId}.${id}`);
  }
}

export function newWorkplan(m: Model): string {
  const id = uniqueId('task', m.workplans.map((w) => w.id));
  const proc = m.processors[0]?.id ?? 'cpu';
  m.workplans.push({
    id,
    trigger: { type: 'periodic', period: '10 ms' },
    deadline: '10 ms',
    priority: 1,
    steps: [{ id: 'work', kind: 'compute', on: proc, cycles: 100000 }],
  });
  return id;
}

export function newStep(m: Model, wpId: string, kind: StepSpec['kind']): string | null {
  const w = m.workplans.find((x) => x.id === wpId);
  if (!w) return null;
  const id = uniqueId(kind === 'compute' ? 'compute' : kind === 'transfer' ? 'move' : 'wait', w.steps.map((s) => s.id));
  const last = w.steps[w.steps.length - 1];
  const after = last ? [last.id] : undefined;
  const mem = m.memories[0]?.id ?? 'mem';
  const proc = m.processors[0]?.id ?? 'cpu';
  if (kind === 'compute') w.steps.push({ id, kind, on: proc, cycles: 100000, after });
  else if (kind === 'transfer') w.steps.push({ id, kind, from: mem, to: proc, bytes: '64 KiB', after });
  else w.steps.push({ id, kind, time: '100 us', after });
  return id;
}
