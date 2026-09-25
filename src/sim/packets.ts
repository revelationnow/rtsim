import { PS_PER_S, type CPacketLane, type PacketPlan } from '../model/compile';
import type { Fabric } from './fabric';
import { Heap, type EventQueue } from './heap';
import { StepSeries } from './series';

/**
 * One packet, or a train of back-to-back packets of one transaction served as a unit (same
 * bytes, headers and gaps; arbitration happens between trains).
 */
interface Packet {
  run: PacketTransfer;
  tx: Transaction;
  bytes: number;
  count: number;
  stage: number;
  seq: number;
  enqueuedAt: number;
  /** Cut-through: the tail cannot leave this lane before the previous lane finished + latency. */
  minEnd: number;
  /** Lane packets this object stands for on the lane it is queued at. */
  units: number;
}

interface Transaction {
  left: number;
  /** Payload bytes and packet objects in this transaction, for per-lane header accounting. */
  len: number;
  objects: number;
}

export interface PacketTransferSpec {
  plan: PacketPlan;
  bytes: number;
  prio: number;
  weight: number;
  /** Round-robin arbitration rotates between initiators. */
  master: string;
  /** Streaming begins: the first transaction's request phase is over. */
  onFirstData: () => void;
  onDone: () => void;
}

/** A packet-mode bus lane: packets queue, win arbitration, then occupy the lane for header + payload + gap. */
export class PacketLane {
  readonly busy: StepSeries;
  readonly queue: StepSeries;
  private readonly bwPerPs: number;
  private active = false;
  private waiting = 0;
  private fifo: Packet[] = [];
  private prio: Heap<Packet>;
  private rr = new Map<string, Packet[]>();
  private rrOrder: string[] = [];
  private rrNext = 0;
  private deficit = new Map<string, number>();
  private quantum = 0;
  packets = 0;
  payloadBytes = 0;
  overheadBytes = 0;
  waitSum = 0;
  waitMax = 0;
  served = 0;

  constructor(
    readonly spec: CPacketLane,
    private readonly q: EventQueue,
    private readonly forward: (p: Packet, at: number, minEnd: number, fromCutThrough: boolean) => void,
    seriesLimit: number,
  ) {
    this.bwPerPs = spec.bwBps / PS_PER_S;
    this.busy = new StepSeries(seriesLimit);
    this.queue = new StepSeries(seriesLimit);
    this.prio = new Heap((a, b) => (a.run.spec.prio !== b.run.spec.prio ? a.run.spec.prio > b.run.spec.prio : a.seq < b.seq));
  }

  enqueue(p: Packet, payload: number): void {
    p.enqueuedAt = this.q.now;
    // This lane splits the transaction at its own payload size; share those packets' headers
    // and gaps evenly among the objects that carry the transaction.
    p.units = Math.ceil(p.tx.len / payload - 1e-9) / p.tx.objects;
    if (!this.quantum || payload < this.quantum) this.quantum = Number.isFinite(payload) ? payload : p.bytes;
    this.waiting++;
    if (this.spec.policy === 'fifo') this.fifo.push(p);
    else if (this.spec.policy === 'priority') this.prio.push(p);
    else {
      const key = p.run.spec.master;
      let list = this.rr.get(key);
      if (!list) {
        list = [];
        this.rr.set(key, list);
        this.rrOrder.push(key);
      }
      list.push(p);
    }
    this.queue.set(this.q.now, this.waiting);
    if (!this.active) this.startNext();
  }

  private pick(): Packet | undefined {
    if (this.spec.policy === 'fifo') return this.fifo.shift();
    if (this.spec.policy === 'priority') return this.prio.pop();
    // Deficit round-robin over initiators: byte-fair, so bundling packets into trains does not
    // change anyone's share. Every visit credits a master one quantum; the first master (in
    // rotation order from the last winner) whose credit covers its head packet is served.
    let best = -1;
    let bestRounds = Infinity;
    const n = this.rrOrder.length;
    for (let i = 0; i < n; i++) {
      const k = (this.rrNext + i) % n;
      const key = this.rrOrder[k];
      const list = this.rr.get(key)!;
      if (!list.length) continue;
      const need = list[0].bytes - (this.deficit.get(key) ?? 0);
      const rounds = need <= 0 ? 0 : Math.ceil(need / this.quantum);
      if (rounds < bestRounds) {
        best = k;
        bestRounds = rounds;
      }
    }
    if (best < 0) return undefined;
    if (bestRounds > 0) {
      for (const key of this.rrOrder) if (this.rr.get(key)!.length) this.deficit.set(key, (this.deficit.get(key) ?? 0) + bestRounds * this.quantum);
    }
    const key = this.rrOrder[best];
    const p = this.rr.get(key)!.shift()!;
    const left = (this.deficit.get(key) ?? 0) - p.bytes;
    // A master whose queue empties forfeits leftover credit, as in standard DRR.
    this.deficit.set(key, this.rr.get(key)!.length ? left : 0);
    this.rrNext = best + 1;
    return p;
  }

  private startNext(): void {
    const p = this.pick();
    if (!p) {
      this.active = false;
      this.busy.set(this.q.now, 0);
      return;
    }
    this.waiting--;
    this.queue.set(this.q.now, this.waiting);
    this.active = true;
    this.busy.set(this.q.now, 1);
    const now = this.q.now;
    const wait = now - p.enqueuedAt;
    this.waitSum += wait;
    this.served++;
    if (wait > this.waitMax) this.waitMax = wait;
    const header = this.spec.headerBytes * p.units;
    const service = Math.ceil((p.bytes + header) / this.bwPerPs + this.spec.gapPs * p.units - 1e-6);
    const end = Math.max(now + service, p.minEnd);
    this.packets += p.units;
    this.payloadBytes += p.bytes;
    this.overheadBytes += header;
    // A train pipelines like the packets it stands for: its head moves on after the first
    // packet (or just its header, for cut-through), and its tail cannot leave before `end`.
    const perPacket = p.units > 1 ? service / p.units : service;
    const headDelay = this.spec.cutThrough ? Math.min(perPacket, Math.ceil(this.spec.headerBytes / this.bwPerPs)) : perPacket;
    this.forward(p, Math.min(now + headDelay, end) + this.spec.latPs, end + this.spec.latPs, true);
    this.q.schedule(end, () => this.startNext());
  }
}

let packetSeq = 0;

/**
 * Drives one transfer through its packet plan: issues transactions within the initiator's
 * outstanding window, walks each packet through fluid stages (memories, fluid buses), packet
 * lanes and pure delays, and reports when the last packet lands.
 */
export class PacketTransfer {
  private issued = 0;
  private remainingBytes: number;
  private inFlight = 0;
  private packetsLeft = 0;
  private firstData = false;
  /** Each fluid stage streams this transfer's packets one at a time, like a single flow would. */
  private fluidBusy: boolean[];
  private fluidQueue: Packet[][];
  private readonly txBytes: number;
  private readonly pktBytes: number;
  private readonly window: number;

  constructor(
    readonly spec: PacketTransferSpec,
    private readonly net: PacketNet,
  ) {
    const { plan, bytes } = spec;
    this.remainingBytes = bytes;
    // Trains trade event count for arbitration granularity. A transfer with an outstanding
    // limit keeps every transaction separate, so round trips and bytes in flight are exact;
    // only the packets inside one transaction move as a train. Without a limit the transfer is
    // bandwidth-bound and whole transactions merge into trains.
    const tx = plan.txBytes;
    const p = plan.pktBytes;
    const trainCap = Math.max(p, Math.floor(net.trainBytes / p) * p);
    const group = Number.isFinite(plan.window) ? 1 : Math.max(1, Math.floor(trainCap / tx));
    this.txBytes = tx * group;
    this.window = plan.window;
    this.pktBytes = Math.max(p, Math.min(this.txBytes, trainCap));
    this.fluidBusy = plan.stages.map(() => false);
    this.fluidQueue = plan.stages.map(() => []);
  }

  start(): void {
    if (this.remainingBytes <= 0) {
      this.spec.onFirstData();
      this.spec.onDone();
      return;
    }
    this.issue();
  }

  private issue(): void {
    const { plan } = this.spec;
    while (this.remainingBytes > 0 && this.inFlight < this.window) {
      const txLen = Math.min(this.txBytes, this.remainingBytes);
      this.remainingBytes -= txLen;
      this.inFlight++;
      this.issued++;
      const tx: Transaction = { left: 0, len: txLen, objects: 0 };
      const pkts: Packet[] = [];
      for (let off = 0; off < txLen; off += this.pktBytes) {
        const bytes = Math.min(this.pktBytes, txLen - off);
        const count = Math.max(1, Math.ceil(bytes / this.spec.plan.pktBytes));
        pkts.push({ run: this, tx, bytes, count, stage: 0, seq: packetSeq++, enqueuedAt: 0, minEnd: 0, units: count });
      }
      tx.left = pkts.length;
      tx.objects = pkts.length;
      this.packetsLeft += pkts.length;
      const go = () => {
        if (!this.firstData) {
          this.firstData = true;
          this.spec.onFirstData();
        }
        for (const p of pkts) this.advance(p);
      };
      if (plan.requestPs > 0) this.net.q.after(plan.requestPs, go);
      else go();
    }
  }

  /** Moves a packet into its current stage. */
  advance(p: Packet): void {
    const stages = this.spec.plan.stages;
    if (p.stage >= stages.length) return this.arrived(p);
    const st = stages[p.stage];
    if (st.kind === 'delay') {
      p.stage++;
      this.net.q.after(st.ps, () => this.advance(p));
    } else if (st.kind === 'server') {
      this.net.lanes[st.lane].enqueue(p, st.payload);
    } else if (this.fluidBusy[p.stage]) {
      this.fluidQueue[p.stage].push(p);
    } else {
      this.streamFluid(p);
    }
  }

  /** One persistent flow per fluid stage carries this transfer's packets through it in order. */
  private streamFluid(p: Packet): void {
    const idx = p.stage;
    const st = this.spec.plan.stages[idx];
    if (st.kind !== 'fluid') return;
    this.fluidBusy[idx] = true;
    let current = p;
    this.net.fabric.add({
      usage: st.usage,
      weight: this.spec.weight,
      prio: this.spec.prio,
      cap: Infinity,
      remaining: p.bytes,
      total: p.bytes,
      rate: 0,
      onDone: () => {
        const finished = current;
        finished.stage++;
        this.advance(finished);
        const next = this.fluidQueue[idx].shift();
        if (next) {
          current = next;
          return next.bytes;
        }
        this.fluidBusy[idx] = false;
        return undefined;
      },
    });
  }

  private arrived(p: Packet): void {
    this.packetsLeft--;
    if (--p.tx.left === 0) {
      this.inFlight--;
      this.issue();
    }
    if (this.packetsLeft === 0 && this.remainingBytes <= 0 && this.inFlight === 0) this.spec.onDone();
  }
}

/** All packet lanes of the model plus the glue that forwards packets between stages. */
export class PacketNet {
  readonly lanes: PacketLane[];

  constructor(
    lanes: CPacketLane[],
    readonly q: EventQueue,
    readonly fabric: Fabric,
    readonly trainBytes: number,
    seriesLimit: number,
  ) {
    this.lanes = lanes.map((l) => new PacketLane(l, q, (p, at, minEnd, cut) => this.forward(p, at, minEnd, cut), seriesLimit));
  }

  private forward(p: Packet, at: number, minEnd: number, fromCutThrough: boolean): void {
    p.stage++;
    const next = p.run.spec.plan.stages[p.stage];
    // Only a following packet lane can overlap with the tail still leaving; anything else
    // waits for the whole packet.
    const overlap = fromCutThrough && next?.kind === 'server';
    const when = overlap ? at : Math.max(at, minEnd);
    p.minEnd = overlap ? minEnd : 0;
    this.q.schedule(Math.max(this.q.now, when), () => p.run.advance(p));
  }

  transfer(spec: PacketTransferSpec): void {
    new PacketTransfer(spec, this).start();
  }
}
