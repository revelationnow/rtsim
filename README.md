# RTSim — real-time hardware scoping simulator

A browser-based discrete-event simulator for sizing hardware for real-time workloads. You describe
**processors / HW blocks, memories, buses and DMA engines**, how they connect, and **workplans**
(triggered graphs of compute, data movement and delays with deadlines). RTSim then tells you:

- **Requirements:** average demand against capacity for every core, bus lane, memory and DMA, the
  capacity needed at a target utilization, and a contention-free latency lower bound per deadline.
- **Simulation:** every job's response time and end-to-end latency, deadline misses, latency
  distributions, per-resource utilization over time (average and peak-window), queueing, buffer
  footprint per memory, and a critical-path breakdown of where each job's time went.
- **Timeline:** a zoomable Gantt of every job, core, DMA channel and link. Click a job to trace it
  across the whole system.
- **Sweep & solve:** vary one parameter across a range, or bisect for the smallest value (bandwidth,
  clock, cores…) that meets every deadline, a p99 target or a utilization cap.

```bash
cd rtsim
npm install
npm run dev        # http://localhost:5173
npm test           # engine checks against hand-computed and textbook results
npm run build      # static site in dist/
SINGLE_FILE=1 npm run build   # one self-contained HTML file in dist-single/
```

Models autosave in the browser and can be saved/opened as YAML or JSON. Four examples ship with the
app: an ADAS camera + radar fusion SoC, a PCIe inference accelerator (PCIe, NoC and AXI simulated
packet by packet), a two-task tutorial, and a tiled encoder with ping-pong DMA.

---

## Modeling concepts

### Components

| Kind | Key parameters | Behaviour |
| --- | --- | --- |
| **Processor / HW block** | clock, cores, scheduling policy, preemptive, dispatch overhead, max outstanding + burst | Runs compute steps. Cores share one global ready queue. |
| **Memory** | capacity, bandwidth, read/write latency, duplex | A bandwidth-limited endpoint. Duplex = independent read and write bandwidth. |
| **Bus / interconnect** | protocol (generic, AXI, NoC, PCIe), model (fluid or packet), width × clock × efficiency (or PCIe gen × lanes, or bandwidth), hop latency, duplex, packet size, header, gap, arbitration, switching | A link simulated either as shared bandwidth (fluid) or packet by packet. Duplex = separate read and write channels (AXI), or the two directions of a PCIe link. |
| **DMA engine** | channels, queueing policy, max outstanding + burst | Masters memory-to-memory transfers; requests beyond `channels` wait. |

**Links** are undirected edges between components. A transfer is routed along the fewest bus hops;
only buses can be intermediate nodes (a memory or processor is never a pass-through).

### Transfers and the interconnect model

Every transfer has an **initiator** (master): the DMA or processor in `via`, else the processor
endpoint, else the model's only DMA. Data flows **source → initiator → destination**:

- the *read leg* (source → initiator) uses the **read** lane of each duplex bus it crosses and the
  source memory's read bandwidth;
- the *write leg* (initiator → destination) uses the **write** lanes and the destination memory's write bandwidth;
- on a shared (non-duplex) bus both legs consume the same capacity, so a DMA copy across one bus
  costs twice its size in bus bandwidth — as it does in hardware.

Each bus is simulated one of two ways, chosen per bus (see [Packet-level buses](#packet-level-buses)).
On **fluid** buses, transfer time = **fixed latency + bytes / rate**. The latency is a read's request
trip across the read leg, the source memory's read latency, every hop's latency on the way back and
forward, and the destination's write latency. The **rate** comes from a *fluid* (flow-level)
model: all transfers streaming at a given moment share each resource by **weighted max-min fairness**
(progressive filling), served in **strict priority classes** when `sim.arbitration: priority` (the
default) or ignoring priority when `fair`. Rates are recomputed only when a transfer starts or ends,
so large transfers are cheap to simulate while contention is still accounted exactly on average.

If the initiator declares `maxOutstanding` and `burst`, its rate is also capped by Little's law:
`outstanding × burst / round-trip latency`, where the round trip is twice the hop latency plus the
memory latency, per leg. This is how a DMA with too few outstanding transactions under-uses a fast bus.

### Packet-level buses

Set a bus's `model: packet` (the default for the AXI, NoC and PCIe protocols) and every transfer
that crosses it is split into **transactions** and **packets**:

- A transaction is the initiator's `burst`, clipped to the route's request limit (PCIe max read
  request size); the initiator keeps at most `maxOutstanding` transactions in flight. Throughput
  limited by round trips (Little's law) emerges from this rather than being imposed.
- A read transaction first pays the request trip to the source and the memory's read latency; its
  data then flows back as packets.
- At each packet-mode lane a packet **queues**, wins **arbitration**, then occupies the lane for
  `(payload + header) / bandwidth + gap`, and reaches the next hop after the lane's latency.
  Store-and-forward lanes pass the packet on once it has fully arrived; cut-through (wormhole)
  lanes pass the head on after the header, and the tail follows.
- Each lane packetizes at **its own payload size**: a transfer that crosses a PCIe link with 256 B
  payloads and a NoC with 64 B packets pays TLP headers every 256 B and flit headers every 64 B.
- **Arbitration:** `round-robin` (deficit round-robin between initiators, byte-fair), `priority`
  (higher step priority first) or `fifo`.
- Memories and fluid buses on the same route stay fluid: each transfer streams its packets through
  them as one flow, so bulk and packet traffic still share their bandwidth.

| Protocol | Bandwidth | Defaults |
| --- | --- | --- |
| `axi` | width × clock × efficiency | payload = 16 beats × width, no header, 1-cycle gap per burst, cut-through, duplex R/W channels |
| `noc` | width × clock × efficiency | 64 B packets, one header flit (= width), cut-through (wormhole), duplex |
| `pcie` | lanes × GT/s × encoding (8b/10b, 128b/130b, or FLIT for Gen6) × 0.95 for DLLPs | 256 B max payload, completions of `readPayload` (default = max payload), 512 B max read request, 24 B per TLP (header + sequence + LCRC + framing), store-and-forward |

A **PCIe** link must connect exactly two components; its lanes are the two **physical directions**
("to X"), so a host's writes to the device and the device's reads of host memory share one lane,
and the device's writes to the host use the other. AXI and NoC lanes are read and write channels
relative to the initiator.

**Packet trains.** To keep large DMAs fast, packets of one transaction move together as a train of
up to `sim.maxTrainBytes` (default 4 KiB). Headers, gaps and bytes in flight stay exact, and trains
pipeline through lanes the way their packets would. Transfers without an outstanding limit also merge
whole transactions into trains. The cost is arbitration granularity: other traffic waits for the train
in service instead of one packet. Set `maxTrainBytes` to the packet size for exact per-packet
arbitration. On the PCIe example, 4 KiB trains reproduce the per-packet batch latency to 0.01% with
58× fewer events.

Protocol headers and gaps also apply on fluid buses with a protocol set, as a bandwidth overhead, so
switching a bus between fluid and packet keeps throughput comparable and changes only latency detail.

### Scheduling

Processors run compute steps with **FIFO**, **fixed priority** (higher number wins) or **EDF** (earliest
absolute deadline — the job's activation + its deadline, or the step's own deadline). With
**preemption**, a newly ready step displaces the worst running one when strictly better. Every dispatch
(including resumption after preemption) pays the dispatch overhead, and work only progresses after it.
A compute amount is **cycles** (a plain number, divided by the clock) or a **fixed time** (`12 us`).

DMA channels queue FIFO or by priority. Link priority classes use the step priority.

### Workplans, triggers and jobs

A workplan is a DAG of steps (`compute`, `transfer`, `delay`) linked by `after` dependencies. Each
trigger firing **activates** a job:

| Trigger | Parameters |
| --- | --- |
| `periodic` | period, offset, release jitter (sampled per job), max activations |
| `poisson` | mean interval (exponential gaps), minimum interval |
| `event` | sources (`workplan` or `workplan.step`), `any` / `all` (join), `every n` (decimation), token policy, delay |
| `times` | explicit activation times |

All triggers take `repeat` (jobs per firing — e.g. one per tile). `maxInFlight` limits overlapping jobs;
an activation beyond it is **skipped** (a frame drop) or **queued**.

Event triggers pass **tokens**. With `consume: fifo` every source completion must be processed in
order (queues grow if sources outpace the consumer). With `consume: latest` only the newest completion
per source is kept, like sampling a register — the usual semantics for sensor fusion.

**Response time** runs from activation (not release, so jitter counts) to the last step finishing,
and is checked against `deadline`. Each job also carries the **origin** time of the chain that caused
it (the oldest consumed token for a join), so `e2eDeadline` checks cause-to-effect latency across
chained workplans.

### Buffer footprint

A transfer into a memory holds its bytes from the start of the write until every step that depends
on it has finished (or the job ends, if nothing in the job consumes it). The peak per memory is
reported and compared against capacity. It is a warning, not a blocking allocation.

## Expressions and units

Every number in a model can be a [mathjs](https://mathjs.org) expression with units:

```yaml
params:
  frame: 3840 * 2160 * 2 B
  ddr_bw: 12.8 GB/s
memories:
  - { id: ddr, bandwidth: ddr_bw, readLatency: 110 ns, size: 4 GiB }
```

- **Units:** `ps ns us ms s`, `B kB MB GB KiB MiB GiB bit`, `Hz kHz MHz GHz`, `GB/s`… Give every term a
  unit — `64 B + 1 KiB`, not `64 + 1 KiB`. Plain numbers are bytes, Hz or B/s where those are
  expected, but a time must carry a unit.
- **Precedence trap:** `1/fps s` is `1/(fps·s)`, a frequency. Write `1 s / fps`. The validator
  points this out.
- **Names:** parameters (in order), the workplan's per-job `vars`, `job` (index), `t` (activation
  time in seconds) and `in_bytes` (bytes delivered by the compute step's preceding transfers).
- **Distributions** (seeded, one independent stream per workplan so changing one workplan does not
  reshuffle another): `uniform(a, b)`, `normal(mu, sigma)`, `exponential(mean)`,
  `lognormal(median, sigma)`, `triangular(a, mode, b)`, `choice(...)`, `chance(p)`, `poisson(lambda)`,
  plus `clamp(x, lo, hi)` and everything in mathjs (`round`, `log2`, `min`, `max`, …).

Per-job `vars` are drawn once per job and shared by all its steps, so data-dependent sizes stay
consistent — e.g. `objects = round(clamp(normal(12, 5), 0, 64))` driving both an output transfer and
a post-processing step.

## Reading the results

- **Utilization** is exact: bytes carried ÷ (capacity × time) for links, busy core-time ÷ (cores ×
  time) for processors. **Peak window** is the largest average over any window of `sim.utilWindow`
  (default: duration / 100), found exactly from the piecewise-constant signal.
- **Where the time goes** walks each job's critical path backwards from its last step through the
  predecessor that finished last, and splits the time into executing, waiting for a core, preempted,
  waiting for a DMA channel, access latency, moving data at the uncontended rate, and **contention** —
  the extra streaming time caused by sharing links. The parts add up to the response time.
- **Requirements** replaces every distribution with its mean and ignores contention: it is the
  sustained load (a necessary condition), not a guarantee. Use simulation and the solver for that.
- **Sweep & solve** reuse the same seed for every run (common random numbers) so differences come from
  the parameter. The solver bisects and assumes the requirement is monotone in the parameter.

## Assumptions and limits

RTSim is for early architecture scoping; it trades cycle accuracy for speed and clarity.

- Fluid buses share bandwidth at flow level; packet buses arbitrate and serialize packets. Neither
  models finite buffers or backpressure: queues at a lane are unbounded. There is no DRAM
  bank/page/refresh model, no caches, no coherency traffic; fold those into memory bandwidth,
  efficiency and latency figures.
- On fluid buses a transfer's latency is paid once, up front; bandwidth is consumed while streaming.
- Read requests on packet buses cost latency but no link bandwidth; write responses are not modeled
  (an initiator's transaction slot frees when its last packet lands).
- Memories stay fluid even on packet routes.
- Processor-initiated transfers do not occupy a core. Model a CPU `memcpy` as a transfer plus a
  compute step if the core time matters. A memory-bound compute can be modeled as a compute step and a
  transfer that run in parallel between the same dependencies.
- Routing takes the fewest bus hops; there is no per-transfer route override yet.
- Memory capacity is checked, not enforced (allocation never blocks).
- Time is integer picoseconds, so runs are exact and reproducible up to about 2.5 hours of simulated time.

## Validation

`npm test` checks the engine against results that can be derived by hand or from theory:
transfer time = latency + size / bottleneck bandwidth; fair sharing and max-min re-sharing when a flow
finishes; strict priority; Little's-law rate caps; shared vs duplex bus costs of a DMA copy; DMA channel
queueing; fixed-priority preemptive response times against classic response-time analysis
(R₃ = 10 ms for C = 1, 2, 3 / T = 4, 6, 12); EDF meeting every deadline at 100% utilization where
rate-monotonic misses; fork-join DAGs on multiple cores; joins, decimation, overrun handling;
Poisson inter-arrival statistics; the solver against an analytic bandwidth requirement; and
the static analysis against rate × size.

Packet mode is checked the same way: one packet costs header + payload serialization plus hop
latency; packets pipeline back to back; cut-through beats store-and-forward by exactly one
serialization per extra hop; a small transfer behind bulk traffic waits for one packet under
round-robin or priority but for the whole queue under FIFO; outstanding windows give Little's-law
throughput; bulk throughput agrees with the fluid model; each lane counts headers at its own
packet size; PCIe bandwidth follows generation × lanes × encoding; and PCIe directions map to the
right physical lanes.

## Project layout

```
src/model/     schema (types.ts), units & expressions (expr.ts), compiler & router (compile.ts),
               seeded RNG, YAML I/O, editing helpers
src/sim/       event queue, fluid fabric, processor/DMA schedulers, simulator, statistics,
               static analysis, sweeps & solver, web worker
src/views/     Architecture, Workplans, Parameters, Source, Requirements, Results, Timeline, Sweep
src/ui/        store (zustand, undo/redo, autosave), charts, form components, worker client
src/examples/  example models
```

## License

Copyright 2026 revelationnow. Licensed under the [Apache License, Version 2.0](LICENSE).
If you redistribute RTSim or work derived from it, keep the [`NOTICE`](NOTICE) file with it.
