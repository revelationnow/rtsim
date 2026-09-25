import { describe, expect, it } from 'vitest';
import { migrateBusTypes, templateCopy } from '../model/busTypes';
import { compile } from '../model/compile';
import type { BusSpec, Model, WorkplanSpec } from '../model/types';
import type { SimResult } from './result';
import { runModel } from './simulate';

const NS = 1e3;

/**
 * Three blocks on one link. Pushes between processors have no memory on the path, so the
 * packet timing is exactly header + payload serialization plus hop latency.
 * The default link: 16 GB/s = 16 B/ns, 16 B header, 10 ns per hop, 64 B packets.
 */
function model(workplans: WorkplanSpec[], link: Partial<BusSpec> = {}, extra: Partial<Model> = {}): Model {
  return {
    name: 'packets',
    processors: [
      { id: 'a', freq: '1 GHz' },
      { id: 'b', freq: '1 GHz' },
      { id: 'c', freq: '1 GHz' },
    ],
    memories: [{ id: 'ddr', size: '1 GiB', bandwidth: '1000000 GB/s', readLatency: '100 ns' }],
    buses: [{ id: 'link', model: 'packet', bandwidth: '16 GB/s', latency: '10 ns', maxPayload: 64, header: 16, ...link }],
    links: [
      ['a', 'link'],
      ['b', 'link'],
      ['c', 'link'],
      ['ddr', 'link'],
    ],
    workplans,
    sim: { duration: '1 ms' },
    ...extra,
  };
}

const push = (id: string, from: string, bytes: string | number, at = '0 ns', priority = 0): WorkplanSpec => ({
  id,
  priority,
  trigger: { type: 'times', times: [at] },
  steps: [{ id: 'x', kind: 'transfer', from, to: 'b', bytes }],
});

function run(m: Model): SimResult {
  const r = runModel(m);
  if (!r.ok) throw new Error(`${r.error}\n${JSON.stringify(r.issues ?? [], null, 2)}`);
  return r;
}
const resp = (r: SimResult, id: string) => r.workplans.find((w) => w.id === id)!.response.max;

describe('packet-level buses', () => {
  it('charges one packet header + payload serialization plus hop latency', () => {
    const r = run(model([push('p', 'a', 64)]));
    // (64 + 16) B / 16 B/ns = 5 ns, then 10 ns hop latency.
    expect(resp(r, 'p')).toBe(15 * NS);
  });

  it('pipelines packets back to back on a lane', () => {
    const r = run(model([push('p', 'a', '64 KiB')]));
    // 1024 packets x 5 ns, plus the last packet's 10 ns hop latency.
    expect(resp(r, 'p')).toBe(1024 * 5 * NS + 10 * NS);
    const lane = r.resources.find((x) => x.id === 'link')!;
    expect(lane.extra!.packets).toBe(1024);
    expect(lane.extra!.overhead).toBeCloseTo(16 / 80, 12);
  });

  it('forwards cut-through packets once the header arrives', () => {
    const twoHops = (switching: BusSpec['switching']): Model => ({
      ...model([push('p', 'a', 64)]),
      buses: [
        { id: 'l1', model: 'packet', bandwidth: '16 GB/s', latency: '10 ns', maxPayload: 64, header: 16, switching },
        { id: 'l2', model: 'packet', bandwidth: '16 GB/s', latency: '10 ns', maxPayload: 64, header: 16, switching },
      ],
      links: [
        ['a', 'l1'],
        ['l1', 'l2'],
        ['l2', 'b'],
      ],
    });
    // Store-and-forward: (5 + 10) per hop.
    expect(resp(run(twoHops('store-and-forward')), 'p')).toBe(30 * NS);
    // Cut-through: header (1 ns) + 10 ns to reach hop 2, then the full 5 ns there + 10 ns.
    expect(resp(run(twoHops('cut-through')), 'p')).toBe(26 * NS);
  });

  const perPacket = { sim: { duration: '1 ms', maxTrainBytes: 64 } };

  it('makes a small transfer wait only for the packet in service under round-robin', () => {
    const r = run(model([push('bulk', 'a', '64 KiB'), push('ctrl', 'c', 64, '1002 ns')], {}, perPacket));
    // Packet 200 of the bulk stream occupies [1000, 1005] ns; ctrl wins the next turn:
    // 3 ns wait + 5 ns + 10 ns.
    expect(resp(r, 'ctrl')).toBe(18 * NS);
  });

  it('queues a small transfer behind everything already waiting under FIFO', () => {
    const r = run(model([push('bulk', 'a', '64 KiB'), push('ctrl', 'c', 64, '1002 ns')], { arbitration: 'fifo' }, perPacket));
    // All 1024 bulk packets were queued at t = 0; ctrl goes after the last one ends at 5120 ns.
    expect(resp(r, 'ctrl')).toBe(5120 * NS + 5 * NS + 10 * NS - 1002 * NS);
  });

  it('lets a higher-priority packet overtake under priority arbitration', () => {
    const r = run(model([push('bulk', 'a', '64 KiB', '0 ns', 1), push('ctrl', 'c', 64, '1002 ns', 9)], { arbitration: 'priority' }, perPacket));
    expect(resp(r, 'ctrl')).toBe(18 * NS);
  });

  it('bounds the wait behind bulk traffic by one train with the default 4 KiB trains', () => {
    const r = run(model([push('bulk', 'a', '64 KiB'), push('ctrl', 'c', 64, '1002 ns')]));
    // Trains of 64 packets take 320 ns; the one in service ends at 1280 ns.
    expect(resp(r, 'ctrl')).toBe(1280 * NS + 5 * NS + 10 * NS - 1002 * NS);
  });

  it('is limited by outstanding transactions per round trip (Little’s law)', () => {
    const m = model([
      {
        id: 'rd',
        trigger: { type: 'times', times: ['0 ns'] },
        steps: [{ id: 'x', kind: 'transfer', from: 'ddr', to: 'a', bytes: '64 KiB' }],
      },
    ], { header: 0 });
    m.processors[0] = { id: 'a', freq: '1 GHz', maxOutstanding: 2, burst: 64 };
    const r = run(m);
    // Each transaction: 10 ns request + 100 ns DDR + 4 ns on the link + 10 ns back ≈ 124 ns,
    // sometimes +4 ns when both outstanding packets meet at the link.
    const rounds = 1024 / 2;
    expect(resp(r, 'rd')).toBeGreaterThanOrEqual(rounds * 124 * NS);
    expect(resp(r, 'rd')).toBeLessThanOrEqual(rounds * 128 * NS + 10 * NS);
  });

  it('agrees with the fluid model on bulk throughput once header overhead is counted', () => {
    const bulk = [push('p', 'a', '4 MiB')];
    const packet = run(model(bulk));
    const fluid = run(model(bulk, { model: 'fluid' }));
    // Fluid charges the same 80/64 overhead as a bandwidth factor; only latency details differ.
    expect(Math.abs(resp(packet, 'p') - resp(fluid, 'p')) / resp(packet, 'p')).toBeLessThan(0.001);
  });

  it('keeps total time and bytes in flight when packets travel in trains', () => {
    const exact = run(model([push('p', 'a', '1 MiB')], {}, perPacket));
    const trains = run(model([push('p', 'a', '1 MiB')]));
    expect(resp(trains, 'p')).toBe(resp(exact, 'p'));

    // Window-limited reads: 4 outstanding 64 B transactions give the same throughput either way.
    const reads = (sim: Partial<Model['sim']>) => {
      const m = model(
        [{ id: 'rd', trigger: { type: 'times', times: ['0 ns'] }, steps: [{ id: 'x', kind: 'transfer', from: 'ddr', to: 'a', bytes: '256 KiB' }] }],
        { header: 0 },
        { sim: { duration: '10 ms', ...sim } },
      );
      m.processors[0] = { id: 'a', freq: '1 GHz', maxOutstanding: 4, burst: 64 };
      return resp(run(m), 'rd');
    };
    const ratio = reads({}) / reads({ maxTrainBytes: 64 });
    expect(ratio).toBeGreaterThan(0.98);
    expect(ratio).toBeLessThan(1.03);
  });
});

describe('mixed packet sizes along a route', () => {
  it('charges each lane headers at its own packet size', () => {
    const m: Model = {
      ...model([{ id: 'w', trigger: { type: 'times', times: ['0 ns'] }, steps: [{ id: 'x', kind: 'transfer', from: 'a', to: 'b', bytes: '64 KiB' }] }]),
      buses: [
        { id: 'pcie', model: 'packet', bandwidth: '8 GB/s', latency: '100 ns', maxPayload: 256, maxRequest: 256, header: 24, duplex: true },
        { id: 'noc', model: 'packet', bandwidth: '64 GB/s', latency: '10 ns', maxPayload: 64, header: 32, duplex: true },
      ],
      links: [
        ['a', 'pcie'],
        ['pcie', 'noc'],
        ['noc', 'b'],
      ],
    };
    const r = run(m);
    const lane = (id: string) => r.resources.find((x) => x.id === id)!.extra!;
    expect(lane('pcie:wr').overhead).toBeCloseTo(24 / (256 + 24), 9);
    expect(lane('pcie:wr').packets).toBeCloseTo(256, 9);
    expect(lane('noc:wr').overhead).toBeCloseTo(32 / (64 + 32), 9);
    expect(lane('noc:wr').packets).toBeCloseTo(1024, 9);
  });
});

describe('PCIe link direction', () => {
  it('puts host writes and device reads of host memory on the same physical lane', () => {
    const m: Model = {
      name: 'pcie',
      processors: [
        { id: 'host', freq: '3 GHz' },
        { id: 'dev', freq: '1 GHz' },
      ],
      memories: [
        { id: 'hmem', size: '1 GiB', bandwidth: '100 GB/s', readLatency: '80 ns' },
        { id: 'dmem', size: '1 GiB', bandwidth: '100 GB/s', readLatency: '80 ns' },
      ],
      buses: [
        { id: 'hbus', bandwidth: '100 GB/s', latency: '10 ns', duplex: true },
        { id: 'pcie', type: 'pcie', vars: { lanes: 4 }, latency: '200 ns' },
        { id: 'dbus', bandwidth: '100 GB/s', latency: '10 ns', duplex: true },
      ],
      busTypes: [templateCopy('pcie')!],
      links: [
        ['host', 'hbus'],
        ['hmem', 'hbus'],
        ['hbus', 'pcie'],
        ['pcie', 'dbus'],
        ['dev', 'dbus'],
        ['dmem', 'dbus'],
      ],
      workplans: [
        { id: 'mmio', trigger: { type: 'times', times: ['0 ns'] }, steps: [{ id: 'x', kind: 'transfer', from: 'host', to: 'dmem', bytes: '64 KiB' }] },
        { id: 'fetch', trigger: { type: 'times', times: ['0 ns'] }, steps: [{ id: 'x', kind: 'transfer', from: 'hmem', to: 'dev', bytes: '64 KiB' }] },
        { id: 'writeback', trigger: { type: 'times', times: ['0 ns'] }, steps: [{ id: 'x', kind: 'transfer', from: 'dev', to: 'hmem', bytes: '64 KiB' }] },
      ],
      sim: { duration: '1 ms' },
    };
    const r = run(m);
    const toDev = r.resources.find((x) => x.name.includes('to dbus'))!;
    const toHost = r.resources.find((x) => x.name.includes('to hbus'))!;
    expect(toDev.extra!.packets).toBeGreaterThanOrEqual(512); // mmio writes + fetch completions
    expect(toHost.extra!.packets).toBe(256); // writeback only, 256 B payloads
  });
});

describe('bus types', () => {
  const withType = (types: Model['busTypes'], link: Partial<BusSpec>): Model => ({ ...model([], link), busTypes: types });

  it('computes PCIe bandwidth from the template\'s lane variables', () => {
    const c = compile(withType([templateCopy('pcie')!], { type: 'pcie', bandwidth: undefined, maxPayload: undefined, header: undefined, model: undefined }));
    if (!c.ok) throw new Error(JSON.stringify(c.issues));
    const bus = c.model.buses[0];
    // 8 lanes x 16 Gb/s x 128/130 encoding, x 0.95 for DLLPs and flow control.
    expect(bus.bwBps).toBeCloseTo((8 * 16e9 * (128 / 130) * 0.95) / 8, 0);
    expect(bus.duplex).toBe(true);
    expect(bus.direction).toBe('physical');
    expect(bus.pkt.cutThrough).toBe(false);
    expect(bus.pkt.maxRequest).toBe(512);
    expect(bus.typeName).toBe('PCIe');
  });

  it('fills AXI and NoC defaults from each bus\'s own width and clock', () => {
    const c = compile({
      ...model([]),
      busTypes: [templateCopy('axi')!, templateCopy('noc')!],
      buses: [
        { id: 'axi', type: 'axi', width: '128 bit', freq: '1 GHz' },
        { id: 'noc', type: 'noc', width: '256 bit', freq: '1 GHz' },
      ],
      links: [['a', 'axi'], ['axi', 'noc'], ['noc', 'b']],
    });
    if (!c.ok) throw new Error(JSON.stringify(c.issues));
    const [axi, noc] = c.model.buses;
    expect(axi.mode).toBe('packet');
    expect(axi.pkt.payload).toBe(256); // 16 x width
    expect(axi.pkt.gapPs).toBe(1000); // 1 / freq
    expect(noc.pkt.headerBytes).toBe(32); // one flit of the width
    expect(noc.pkt.cutThrough).toBe(true);
  });

  it('lets a bus override its type\'s fields and variables', () => {
    const serdes = {
      id: 'serdes',
      name: 'Custom SerDes link',
      vars: { lanes: 4, lane_rate: '25 Gb/s', coding: '64 / 66' },
      bandwidth: 'lanes * lane_rate * coding',
      model: 'packet' as const,
      duplex: true,
      direction: 'physical' as const,
      maxPayload: '512 B',
      header: '16 B',
    };
    const c = compile(withType([serdes], { type: 'serdes', bandwidth: undefined, maxPayload: undefined, header: '8 B', vars: { lanes: 2 } }));
    if (!c.ok) throw new Error(JSON.stringify(c.issues));
    const bus = c.model.buses[0];
    expect(bus.bwBps).toBeCloseTo((2 * 25e9 * (64 / 66)) / 8, 0); // bus var wins
    expect(bus.pkt.headerBytes).toBe(8); // bus field wins
    expect(bus.pkt.payload).toBe(512); // inherited
    expect(bus.direction).toBe('physical');
  });

  it('converts models written with protocol, gen and lanes', () => {
    const old = model([], { protocol: 'pcie', gen: 3, lanes: 16, bandwidth: undefined, maxPayload: undefined, header: undefined, model: undefined });
    const m = migrateBusTypes(structuredClone(old));
    expect(m.buses[0].type).toBe('pcie');
    expect(m.busTypes?.map((t) => t.id)).toEqual(['pcie']);
    const c = compile(m);
    if (!c.ok) throw new Error(JSON.stringify(c.issues));
    expect(c.model.buses[0].bwBps).toBeCloseTo((16 * 8e9 * (128 / 130) * 0.95) / 8, 0);
  });

  it('explains unknown types and undefined names', () => {
    const r1 = compile(withType([], { type: 'nope' }));
    expect(!r1.ok && r1.issues.some((i) => i.path === 'buses.link.type' && i.message.includes('unknown bus type'))).toBe(true);
    const r2 = compile(withType([templateCopy('axi')!], { type: 'axi', maxPayload: undefined }));
    expect(!r2.ok && r2.issues.some((i) => i.message.includes('set width on this bus'))).toBe(true);
  });

  it('chops PCIe reads into completions of readPayload', () => {
    const read = (readPayload: number) => {
      const m = withType([templateCopy('pcie')!], { type: 'pcie', vars: { lanes: 4 }, bandwidth: undefined, maxPayload: 256, readPayload, header: 24 });
      m.workplans = [
        { id: 'rd', trigger: { type: 'times', times: ['0 ns'] }, steps: [{ id: 'x', kind: 'transfer', from: 'ddr', to: 'a', bytes: '256 KiB' }] },
      ];
      return resp(run(m), 'rd');
    };
    // 64 B completions carry 24 B of header each instead of per 256 B: slower.
    const ratio = read(64) / read(256);
    expect(ratio).toBeGreaterThan(((64 + 24) / 64) / ((256 + 24) / 256) * 0.97);
  });
});
