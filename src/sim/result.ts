/** Everything a run produces. All times are in picoseconds, sizes in bytes, rates in bytes/s. */

export interface Summary {
  count: number;
  min: number;
  mean: number;
  p50: number;
  p90: number;
  p99: number;
  max: number;
  std: number;
}

export interface JobRecord {
  idx: number;
  activation: number;
  release: number;
  /** -1 while unfinished at the end of the run. */
  completion: number;
  origin: number;
  missed: boolean;
  e2eMissed: boolean;
}

export interface PathStep {
  step: string;
  kind: 'compute' | 'transfer' | 'delay';
  resource: string;
  readyT: number;
  startT: number;
  endT: number;
  parts: Record<string, number>;
}

export interface StepStat {
  id: string;
  kind: 'compute' | 'transfer' | 'delay';
  resource: string;
  count: number;
  /** Ready to start: queueing for a core or DMA channel. */
  wait: Summary;
  /** Start to end: execution incl. preemption, or latency + streaming. */
  service: Summary;
  /** Mean bytes per transfer (0 otherwise). */
  meanBytes: number;
  deadlineMisses: number;
}

export interface WorkplanResult {
  id: string;
  name: string;
  deadlinePs: number | null;
  e2eDeadlinePs: number | null;
  activations: number;
  released: number;
  completed: number;
  skipped: number;
  /** Completed late, or still running past the deadline at the end. */
  missed: number;
  e2eMissed: number;
  incomplete: number;
  response: Summary;
  e2e: Summary;
  jobs: JobRecord[];
  steps: StepStat[];
  /** Mean time per category along the critical path of completed jobs. */
  breakdown: Record<string, number>;
  worst: { job: number; response: number; path: PathStep[] } | null;
}

export interface ResourceResult {
  id: string;
  name: string;
  kind: 'processor' | 'memory' | 'bus' | 'dma';
  lane: 'rw' | 'rd' | 'wr' | 'cores' | 'channels';
  /** How a bus or memory lane was simulated. */
  mode?: 'fluid' | 'packet';
  /** Bytes/s for memory and bus lanes; cores or channels otherwise. */
  capacity: number;
  utilization: number;
  peakWindowUtil: number;
  bytes: number;
  /** Mean achieved throughput over the run (bytes/s), links only. */
  throughput: number;
  series: { t: number[]; v: number[]; truncated: boolean };
  queue?: { t: number[]; v: number[]; mean: number; max: number };
  extra?: Record<string, number>;
}

export interface FootprintResult {
  id: string;
  name: string;
  size: number;
  peak: number;
  mean: number;
  series: { t: number[]; v: number[] };
}

/** Flattened timeline records — kept as numbers so they are cheap to move between threads. */
export interface Trace {
  /** Per segment: proc, core, t0, t1, wp, job, step. */
  compute: number[];
  /** Per transfer: wp, job, step, readyT, startT, streamT, endT, bytes. */
  transfers: number[];
  /** Per delay: wp, job, step, t0, t1. */
  delays: number[];
  truncated: boolean;
}

export const COMPUTE_STRIDE = 7;
export const TRANSFER_STRIDE = 8;
export const DELAY_STRIDE = 5;

export interface SimResult {
  ok: true;
  durationPs: number;
  events: number;
  wallMs: number;
  utilWindowPs: number;
  workplans: WorkplanResult[];
  resources: ResourceResult[];
  footprints: FootprintResult[];
  trace: Trace;
  warnings: string[];
  /** Resolved step and component names for the timeline. */
  names: {
    procs: string[];
    procCores: number[];
    wps: string[];
    steps: string[][];
    stepKinds: string[][];
    /** Resource ids each transfer step streams through. */
    transferRes: string[][][];
    /** The DMA id a transfer step queues on, or '' when mastered by a processor. */
    transferDma: string[][];
    dmas: string[];
    dmaChannels: number[];
    deadlines: (number | null)[];
  };
}

export interface SimFailure {
  ok: false;
  error: string;
  issues?: { path: string; message: string; severity: 'error' | 'warning' }[];
}
