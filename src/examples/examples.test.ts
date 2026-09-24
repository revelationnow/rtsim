import { describe, expect, it } from 'vitest';
import { compile } from '../model/compile';
import { analyze } from '../sim/analysis';
import { runModel } from '../sim/simulate';
import { EXAMPLES } from './index';

const f = (ps: number) => `${(ps / 1e9).toFixed(3)}ms`;

describe('examples', () => {
  for (const { key, model } of EXAMPLES) {
    it(`${key} compiles, analyzes and simulates`, () => {
      const c = compile(model);
      expect(c.ok ? [] : c.issues).toEqual([]);
      if (!c.ok) return;
      const a = analyze(c.model);
      expect(a.errors).toEqual([]);
      const r = runModel(model);
      if (!r.ok) throw new Error(JSON.stringify(r));
      if (process.env.VERBOSE) {
        console.log(`\n== ${key}: ${r.events} events in ${r.wallMs.toFixed(0)} ms`);
        for (const w of r.workplans)
          console.log(`${w.id.padEnd(12)} act=${w.activations} done=${w.completed} miss=${w.missed} skip=${w.skipped} mean=${f(w.response.mean)} p99=${f(w.response.p99)} max=${f(w.response.max)} e2eMax=${f(w.e2e.max)}`);
        for (const x of r.resources) console.log(`${x.id.padEnd(12)} util=${(x.utilization * 100).toFixed(1)}% peak=${(x.peakWindowUtil * 100).toFixed(1)}%`);
        for (const d of a.demand) console.log(`demand ${d.id.padEnd(10)} ${(d.utilization * 100).toFixed(1)}%`);
        for (const b of a.bounds) console.log(`bound ${b.id.padEnd(10)} ${f(b.lowerBoundPs)} / ${b.deadlinePs ? f(b.deadlinePs) : '-'}`);
        for (const fp of r.footprints) console.log(`footprint ${fp.id} peak=${fp.peak}`);
        console.log(r.warnings);
      }
      expect(r.workplans.every((w) => w.completed > 0)).toBe(true);
    });
  }
});
