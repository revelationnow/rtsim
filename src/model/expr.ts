import { all, create, type EvalFunction, type MathNode, type Unit } from 'mathjs';
import type { Rng } from './rng';

/**
 * One mathjs instance for the whole app. Model fields are mathjs expressions, so units,
 * arithmetic and parameter references all come from the same parser: "4 MiB / (12.8 GB/s)"
 * evaluates to 327.68 us, "frame_w * frame_h * 2 B" to a byte count.
 */
export const math = create(all, { number: 'number' });

type Mode = 'sample' | 'mean';

/**
 * The distribution functions read the active RNG from here. Evaluation is synchronous,
 * so a module-level context is safe; `withRng` restores the previous one on exit.
 */
const ctx: { rng: Rng | null; mode: Mode } = { rng: null, mode: 'mean' };

export function withRng<T>(rng: Rng | null, mode: Mode, fn: () => T): T {
  const prev = { rng: ctx.rng, mode: ctx.mode };
  ctx.rng = rng;
  ctx.mode = rng ? mode : 'mean';
  try {
    return fn();
  } finally {
    ctx.rng = prev.rng;
    ctx.mode = prev.mode;
  }
}

function u01(): number {
  if (!ctx.rng) throw new Error('random function used outside a simulation context');
  return ctx.rng.next();
}

type Val = number | Unit;
const isUnit = (v: unknown): v is Unit => math.typeOf(v) === 'Unit';

/** Lets `uniform(0, 50 us)` work: a bare 0 adopts the other argument's unit. */
function align(a: Val, b: Val): [Val, Val] {
  if (isUnit(b) && a === 0) return [math.multiply(b, 0) as Unit, b];
  if (isUnit(a) && b === 0) return [a, math.multiply(a, 0) as Unit];
  return [a, b];
}

const add = (a: Val, b: Val) => math.add(...align(a, b)) as Val;
const sub = (a: Val, b: Val) => math.subtract(...align(a, b)) as Val;
const mul = (a: Val, k: number) => math.multiply(a, k) as Val;

/** Random functions available in every expression. In 'mean' mode each returns its expectation. */
export const RANDOM_FUNCTIONS = [
  'uniform',
  'normal',
  'exponential',
  'lognormal',
  'triangular',
  'choice',
  'chance',
  'poisson',
] as const;

math.import(
  {
    /** Uniform on [a, b]. */
    uniform(a: Val, b: Val): Val {
      if (ctx.mode === 'mean') return mul(add(a, b), 0.5);
      return add(a, mul(sub(b, a), u01()));
    },
    /** Normal(mu, sigma). Wrap in clamp() if negative values are meaningless. */
    normal(mu: Val, sigma: Val): Val {
      if (ctx.mode === 'mean') return mu;
      return add(mu, mul(sigma, ctx.rng!.normal()));
    },
    /** Exponential with the given mean. */
    exponential(mean: Val): Val {
      if (ctx.mode === 'mean') return mean;
      return mul(mean, -Math.log(1 - u01()));
    },
    /** Log-normal parameterised by its median and the sigma of the underlying normal. */
    lognormal(median: Val, sigma: number): Val {
      if (ctx.mode === 'mean') return mul(median, Math.exp((sigma * sigma) / 2));
      return mul(median, Math.exp(sigma * ctx.rng!.normal()));
    },
    /** Triangular on [a, b] with the given mode. */
    triangular(a: Val, mode: Val, b: Val): Val {
      if (ctx.mode === 'mean') return mul(add(add(a, mode), b), 1 / 3);
      const [na, nm, nb] = [a, mode, b].map((v) => (isUnit(v) ? v.toNumber(unitName(v)) : v)) as number[];
      const unitRef = [a, mode, b].find(isUnit);
      const u = u01();
      const fc = (nm - na) / (nb - na || 1);
      const x = u < fc ? na + Math.sqrt(u * (nb - na) * (nm - na)) : nb - Math.sqrt((1 - u) * (nb - na) * (nb - nm));
      return unitRef ? math.unit(x, unitName(unitRef)) : x;
    },
    /** One of the arguments, equally likely. */
    choice(...values: Val[]): Val {
      if (values.length === 0) throw new Error('choice() needs at least one value');
      if (ctx.mode === 'mean') return mul(values.reduce((s, v) => add(s, v)), 1 / values.length);
      return values[Math.min(values.length - 1, Math.floor(u01() * values.length))];
    },
    /** 1 with probability p, else 0. */
    chance(p: number): number {
      if (ctx.mode === 'mean') return p;
      return u01() < p ? 1 : 0;
    },
    /** Poisson-distributed count with mean lambda. */
    poisson(lambda: number): number {
      if (ctx.mode === 'mean') return lambda;
      return ctx.rng!.poisson(lambda);
    },
    /** Clamp x into [lo, hi]. */
    clamp(x: Val, lo: Val, hi: Val): Val {
      return math.min(math.max(x, lo), hi) as Val;
    },
  },
  { override: false },
);

function unitName(u: Unit): string {
  return u.formatUnits();
}

// ---------------------------------------------------------------------------
// Compiled expressions
// ---------------------------------------------------------------------------

export interface CExpr {
  src: string;
  /** True when the value does not depend on per-job state or randomness. */
  constant: boolean;
  value?: unknown;
  code?: EvalFunction;
}

export class ExprError extends Error {}

const randomSet = new Set<string>(RANDOM_FUNCTIONS);

/**
 * Compiles an expression. `dynamic` names symbols that change per job (job vars, `job`,
 * `t`, `in_bytes`); anything that references none of them and calls no random function
 * is folded to a constant against `scope` right away.
 */
export function compileExpr(e: unknown, scope: Record<string, unknown>, dynamic: Set<string>): CExpr {
  if (typeof e === 'number') return { src: String(e), constant: true, value: e };
  if (typeof e !== 'string' || e.trim() === '') throw new ExprError('expected a number or expression');
  let node: MathNode;
  try {
    node = math.parse(e);
  } catch (err) {
    throw new ExprError(`cannot parse "${e}": ${(err as Error).message}`);
  }
  let constant = true;
  node.traverse((n) => {
    if ((n as { isFunctionNode?: boolean }).isFunctionNode) {
      const name = (n as unknown as { fn: { name?: string } }).fn.name;
      if (name && randomSet.has(name)) constant = false;
    } else if ((n as { isSymbolNode?: boolean }).isSymbolNode) {
      if (dynamic.has((n as unknown as { name: string }).name)) constant = false;
    }
  });
  const code = node.compile();
  if (constant) {
    try {
      return { src: e, constant: true, value: code.evaluate({ ...scope }) };
    } catch (err) {
      throw new ExprError(`cannot evaluate "${e}": ${(err as Error).message}`);
    }
  }
  return { src: e, constant: false, code };
}

export function evalExpr(c: CExpr, scope: Record<string, unknown>): unknown {
  if (c.constant) return c.value;
  try {
    return c.code!.evaluate(scope);
  } catch (err) {
    throw new ExprError(`cannot evaluate "${c.src}": ${(err as Error).message}`);
  }
}

/** Evaluate a one-off expression (params, component fields) against a scope. */
export function evaluate(e: unknown, scope: Record<string, unknown>): unknown {
  return evalExpr(compileExpr(e, scope, new Set()), scope);
}

// ---------------------------------------------------------------------------
// Unit conversion into the simulator's base units
// ---------------------------------------------------------------------------

export type Quantity = 'time' | 'bytes' | 'freq' | 'bandwidth' | 'count';

const REF: Record<Exclude<Quantity, 'count'>, { unit: Unit; base: string; hint: string }> = {
  time: { unit: math.unit('s'), base: 's', hint: 'a time such as "80 ns"' },
  bytes: { unit: math.unit('B'), base: 'B', hint: 'a size such as "4 MiB" or a byte count' },
  freq: { unit: math.unit('Hz'), base: 'Hz', hint: 'a frequency such as "1.2 GHz"' },
  bandwidth: { unit: math.unit('B/s'), base: 'B/s', hint: 'a bandwidth such as "12.8 GB/s"' },
};

/**
 * Converts an evaluated value into base units: seconds, bytes, Hz, bytes/s, or a plain
 * count. Plain numbers are accepted as bytes, Hz and bytes/s; a time must carry a unit
 * (except 0), since "80" silently meaning 80 seconds is exactly the bug to avoid.
 */
export function toBase(v: unknown, q: Quantity): number {
  if (typeof v === 'boolean') v = v ? 1 : 0;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new ExprError(`value is ${v}`);
    if (q === 'time' && v !== 0) throw new ExprError(`${v} needs a unit — expected ${REF.time.hint}`);
    return v;
  }
  if (isUnit(v)) {
    if (q === 'count') throw new ExprError(`expected a plain number, got ${v.toString()}`);
    const ref = REF[q];
    if (q === 'freq' && v.equalBase(math.unit('1/s'))) return v.toNumber('Hz');
    if (!v.equalBase(ref.unit)) throw new ExprError(`${v.toString()} is not ${ref.hint}`);
    const n = v.toNumber(ref.base);
    if (!Number.isFinite(n)) throw new ExprError(`value is ${n}`);
    return n;
  }
  throw new ExprError(`expected ${q === 'count' ? 'a number' : REF[q].hint}`);
}

/** A compute amount: cycles (plain number) or a fixed duration in seconds (time unit). */
export function toWork(v: unknown): { cycles: number } | { seconds: number } {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new ExprError(`cycles is ${v}`);
    return { cycles: v };
  }
  if (isUnit(v) && v.equalBase(REF.time.unit)) return { seconds: v.toNumber('s') };
  throw new ExprError('expected a cycle count or a time such as "12 us"');
}
