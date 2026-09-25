/**
 * The model a user edits. Every numeric field is an `Expr`: either a plain number or a
 * mathjs expression string, optionally carrying units ("12.8 GB/s", "4 MiB", "80 ns",
 * "frame_w * frame_h * 2 B"). Expressions can reference the global `params`, and step
 * expressions can also reference per-job variables and random distributions.
 */
export type Expr = string | number;

export type SchedPolicy = 'fifo' | 'fixed-priority' | 'edf';

export interface ProcessorSpec {
  id: string;
  name?: string;
  /** Clock frequency, e.g. "1.2 GHz". Compute steps given in cycles are divided by this. */
  freq: Expr;
  /** Identical execution units scheduled globally from one ready queue. */
  cores?: Expr;
  policy?: SchedPolicy;
  preemptive?: boolean;
  /** Overhead charged every time a step is dispatched onto a core. */
  contextSwitch?: Expr;
  /** Outstanding-transaction limit when this block initiates transfers (Little's-law rate cap). */
  maxOutstanding?: Expr;
  /** Bytes per transaction for the outstanding limit above. */
  burst?: Expr;
}

export interface MemorySpec {
  id: string;
  name?: string;
  /** Capacity, used for buffer-footprint checks. */
  size: Expr;
  /** Sustained bandwidth of the memory controller / array. */
  bandwidth: Expr;
  readLatency: Expr;
  writeLatency?: Expr;
  /** Independent read and write bandwidth (e.g. dual-ported SRAM). */
  duplex?: boolean;
}

/**
 * Everything that describes how a bus behaves. A bus type sets these as defaults; a bus that
 * uses the type may override any of them. Expressions can use params, the type's `vars`, and
 * the bus's own `width` and `freq` (e.g. a payload of "16 * width" or a gap of "1 / freq").
 */
export interface BusFields {
  /**
   * 'fluid': transfers share bandwidth as continuous flows (fast, average behaviour).
   * 'packet': transfers are split into packets that are arbitrated and served one at a time,
   * each paying serialization and hop latency.
   */
  model?: 'fluid' | 'packet';
  /** Data-path width, e.g. "128 bit" or 16. Used with freq when bandwidth is not given. */
  width?: Expr;
  freq?: Expr;
  /** Fraction of width x freq that is achievable (headers and gaps are counted separately). */
  efficiency?: Expr;
  /** Overrides width x freq x efficiency when set; any expression, e.g. lanes * lane_rate. */
  bandwidth?: Expr;
  /** Latency added per traversal (arbitration + pipeline stages); per packet in packet mode. */
  latency?: Expr;
  /** Two independent lanes instead of one shared one. */
  duplex?: boolean;
  /**
   * What the two duplex lanes mean. 'initiator': read and write channels relative to whoever
   * masters the transfer (AXI, NoC request/response). 'physical': the two directions of a
   * point-to-point link (PCIe, serial links), which must connect exactly two components.
   */
  direction?: 'initiator' | 'physical';
  /** Largest data payload per packet (AXI burst, NoC packet, PCIe max payload size). */
  maxPayload?: Expr;
  /** Payload per packet for data flowing back to a reader (PCIe completions); defaults to maxPayload. */
  readPayload?: Expr;
  /** Largest request (PCIe max read request size); unlimited when not set. */
  maxRequest?: Expr;
  /** Overhead bytes serialized with every packet (header flit, TLP header + framing + CRC). */
  header?: Expr;
  /** Idle time on the link between packets (arbitration bubble, handshake). */
  packetGap?: Expr;
  /** Packet mode: how waiting packets are picked. 'round-robin' rotates between initiators. */
  arbitration?: 'round-robin' | 'priority' | 'fifo';
  /** Packet mode: 'cut-through' forwards a packet once its header arrives (wormhole). */
  switching?: 'store-and-forward' | 'cut-through';
}

/** A reusable bus definition kept in the model: AXI, a NoC, PCIe, or anything you define. */
export interface BusTypeSpec extends BusFields {
  id: string;
  name?: string;
  description?: string;
  /** Variables for this type's expressions, e.g. lanes and lane_rate; buses may override them. */
  vars?: Record<string, Expr>;
}

export interface BusSpec extends BusFields {
  id: string;
  name?: string;
  /** Id of a bus type in the model's busTypes; its fields are this bus's defaults. */
  type?: string;
  /** Overrides for the type's vars. */
  vars?: Record<string, Expr>;
  /** Older models only: converted to `type` (and vars) when the model is loaded. */
  protocol?: string;
  gen?: number;
  lanes?: number;
}

export interface DmaSpec {
  id: string;
  name?: string;
  /** Concurrent transfers; further requests queue for a free channel. */
  channels?: Expr;
  maxOutstanding?: Expr;
  burst?: Expr;
  /** Order in which queued requests get a channel. */
  policy?: 'fifo' | 'priority';
}

/**
 * `repeat` fans one firing out into several activations at the same instant (e.g. one job
 * per tile of a frame); combine it with maxInFlight to model a pipeline.
 */
export type TriggerSpec =
  | { type: 'periodic'; period: Expr; offset?: Expr; jitter?: Expr; count?: number; repeat?: Expr }
  | { type: 'poisson'; interval: Expr; minInterval?: Expr; count?: number; repeat?: Expr }
  | {
      type: 'event';
      sources: string[];
      /** 'any': each source completion counts; 'all': fire once every source has produced. */
      mode?: 'any' | 'all';
      /** Completions needed per firing (decimation). */
      every?: number;
      /**
       * 'fifo': every completion is a token that must be consumed in order (queues build up
       * when sources outpace the consumer). 'latest': only the newest completion per source is
       * kept, like sampling a register — the usual semantics for sensor fusion.
       */
      consume?: 'fifo' | 'latest';
      delay?: Expr;
      repeat?: Expr;
    }
  | { type: 'times'; times: Expr[]; repeat?: Expr };

interface StepBase {
  id: string;
  name?: string;
  /** Steps (in the same workplan) that must finish before this one may start. */
  after?: string[];
  /** Overrides the workplan priority for scheduling and arbitration. Higher wins. */
  priority?: number;
  /** Optional per-step deadline, relative to the job's activation. */
  deadline?: Expr;
}

export interface ComputeStep extends StepBase {
  kind: 'compute';
  on: string;
  /** Plain number = cycles at the processor clock; a time ("12 us") = fixed duration. */
  cycles: Expr;
}

export interface TransferStep extends StepBase {
  kind: 'transfer';
  from: string;
  to: string;
  bytes: Expr;
  /** DMA engine or processor that masters the transfer. Inferred when unambiguous. */
  via?: string;
  /** Share weight among equal-priority transfers on a contended link. */
  weight?: number;
}

export interface DelayStep extends StepBase {
  kind: 'delay';
  time: Expr;
}

export type StepSpec = ComputeStep | TransferStep | DelayStep;

export interface WorkplanSpec {
  id: string;
  name?: string;
  description?: string;
  trigger: TriggerSpec;
  /** Response-time deadline relative to activation. */
  deadline?: Expr;
  /** Deadline relative to the origin of the chain that caused this job (event triggers). */
  e2eDeadline?: Expr;
  priority?: number;
  /** Jobs of this workplan allowed in flight at once. Default unlimited. */
  maxInFlight?: Expr;
  /** What happens to an activation when maxInFlight is reached. */
  onOverrun?: 'skip' | 'queue';
  /** Per-job variables, evaluated in order at release; visible to every step expression. */
  vars?: Record<string, Expr>;
  steps: StepSpec[];
}

export interface SimSettings {
  duration: Expr;
  seed?: number;
  /** Window for peak (sliding-average) utilization. Defaults to duration / 100. */
  utilWindow?: Expr;
  /** Cap on recorded timeline segments; statistics are always complete. */
  traceLimit?: number;
  /**
   * Packet-mode transfers move in trains of consecutive packets up to this size (default 4 KiB):
   * headers, gaps and bytes in flight are exact, but other traffic waits for the train in service
   * rather than a single packet. Set it to the packet size for exact per-packet arbitration.
   */
  maxTrainBytes?: Expr;
  /**
   * How contending transfers share a link. 'priority': higher-priority transfers are served
   * first (strict QoS), equal priorities share max-min fairly by weight. 'fair': priorities
   * are ignored on links and everything shares by weight.
   */
  arbitration?: 'priority' | 'fair';
}

export interface Model {
  name: string;
  description?: string;
  params?: Record<string, Expr>;
  processors: ProcessorSpec[];
  memories: MemorySpec[];
  /** Reusable bus definitions that buses refer to by `type`. */
  busTypes?: BusTypeSpec[];
  buses: BusSpec[];
  dmas?: DmaSpec[];
  /** Undirected topology edges between component ids. */
  links: [string, string][];
  workplans: WorkplanSpec[];
  sim: SimSettings;
  /** Diagram positions, keyed by component or `workplanId/stepId`. */
  layout?: Record<string, { x: number; y: number }>;
}

export type ComponentKind = 'processor' | 'memory' | 'bus' | 'dma';
