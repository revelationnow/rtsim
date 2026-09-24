import YAML from 'yaml';
import type { Model } from './types';

/** Fills in missing collections so partially written files still load. */
export function normalizeModel(raw: unknown): Model {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('the file does not contain a model object');
  const m = raw as Partial<Model>;
  const arr = <T,>(v: T[] | undefined, name: string): T[] => {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) throw new Error(`"${name}" must be a list`);
    return v;
  };
  const links = arr(m.links as [string, string][] | undefined, 'links').map((l, i) => {
    if (Array.isArray(l) && l.length === 2) return [String(l[0]), String(l[1])] as [string, string];
    if (typeof l === 'string' && (l as string).includes('--')) {
      const [a, b] = (l as string).split('--').map((s) => s.trim());
      return [a, b] as [string, string];
    }
    throw new Error(`links[${i}] must be a pair like [cpu, axi] or "cpu -- axi"`);
  });
  return {
    name: m.name ?? 'Untitled model',
    description: m.description,
    params: m.params ?? {},
    processors: arr(m.processors, 'processors'),
    memories: arr(m.memories, 'memories'),
    buses: arr(m.buses, 'buses'),
    dmas: arr(m.dmas, 'dmas'),
    links,
    workplans: arr(m.workplans, 'workplans').map((w) => ({ ...w, steps: arr(w.steps, `workplans.${w.id}.steps`) })),
    sim: m.sim ?? { duration: '100 ms', seed: 1 },
    layout: m.layout,
  };
}

export function toYaml(m: Model, { withLayout = true } = {}): string {
  const out: Partial<Model> = { ...m };
  if (!withLayout) delete out.layout;
  // Links read best as flow-style pairs: [cpu, axi]
  const doc = new YAML.Document(out);
  YAML.visit(doc, {
    Seq(_, node, path) {
      const parent = path[path.length - 1] as { key?: { value?: unknown } } | undefined;
      const inLinks = parent && 'key' in parent && parent.key?.value === 'links';
      const isPair = node.items.length === 2 && node.items.every((i) => YAML.isScalar(i));
      if ((inLinks && isPair) || (parent && 'key' in parent && ['after', 'sources', 'times'].includes(String(parent.key?.value)))) {
        node.flow = true;
      }
    },
    Map(_, node, path) {
      const parent = path[path.length - 1] as { key?: { value?: unknown } } | undefined;
      if (parent && 'key' in parent && parent.key?.value === 'layout') return;
      const grand = path[path.length - 3] as { key?: { value?: unknown } } | undefined;
      if (grand && 'key' in grand && grand.key?.value === 'layout') node.flow = true;
    },
  });
  return doc.toString({ lineWidth: 110 });
}

export function parseModelText(text: string): Model {
  const trimmed = text.trim();
  const raw = trimmed.startsWith('{') ? JSON.parse(trimmed) : YAML.parse(trimmed);
  return normalizeModel(raw);
}
