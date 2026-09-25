import type { BusSpec, BusTypeSpec, Model } from './types';

/**
 * Starting points for bus types. They are ordinary data: adding one copies it into the model,
 * where every field can be changed. Nothing in the simulator knows these names.
 */
export const BUS_TEMPLATES: BusTypeSpec[] = [
  {
    id: 'axi',
    name: 'AXI4',
    description:
      'Bursts of up to 16 beats on separate read and write data channels, with a one-cycle arbitration bubble between bursts. Set width and freq on each bus.',
    model: 'packet',
    duplex: true,
    direction: 'initiator',
    maxPayload: '16 * width',
    header: 0,
    packetGap: '1 / freq',
    arbitration: 'round-robin',
    switching: 'cut-through',
  },
  {
    id: 'noc',
    name: 'NoC',
    description:
      'Packets of up to 64 B plus one header flit of the link width, wormhole-routed. Separate request and response networks. Set width and freq on each bus.',
    model: 'packet',
    duplex: true,
    direction: 'initiator',
    maxPayload: '64 B',
    header: 'width',
    arbitration: 'round-robin',
    switching: 'cut-through',
  },
  {
    id: 'pcie',
    name: 'PCIe',
    description:
      'Point-to-point serial link. Per-lane rate and encoding by generation: Gen1 2.5 Gb/s and Gen2 5 Gb/s with 8b/10b (0.8); Gen3 8, Gen4 16, Gen5 32 Gb/s with 128b/130b; Gen6 64 Gb/s FLIT mode (about 242/256). link_efficiency covers DLLPs, flow control and SKP ordered sets. Each TLP carries about 24 B of header, sequence number, LCRC and framing.',
    vars: { lanes: 8, lane_rate: '16 Gb/s', encoding: '128 / 130', link_efficiency: 0.95 },
    bandwidth: 'lanes * lane_rate * encoding * link_efficiency',
    model: 'packet',
    duplex: true,
    direction: 'physical',
    maxPayload: '256 B',
    readPayload: '256 B',
    maxRequest: '512 B',
    header: '24 B',
    arbitration: 'round-robin',
    switching: 'store-and-forward',
  },
];

const PCIE_GEN: Record<number, { rate: string; encoding: string }> = {
  1: { rate: '2.5 Gb/s', encoding: '8 / 10' },
  2: { rate: '5 Gb/s', encoding: '8 / 10' },
  3: { rate: '8 Gb/s', encoding: '128 / 130' },
  4: { rate: '16 Gb/s', encoding: '128 / 130' },
  5: { rate: '32 Gb/s', encoding: '128 / 130' },
  6: { rate: '64 Gb/s', encoding: '242 / 256' },
};

export function templateCopy(id: string): BusTypeSpec | null {
  const t = BUS_TEMPLATES.find((x) => x.id === id);
  return t ? structuredClone(t) : null;
}

/**
 * Converts models written before bus types existed: a bus with `protocol: axi | noc | pcie`
 * (and PCIe `gen` / `lanes`) now refers to a bus type of that name, which is added to the model
 * from the templates if it is missing. Returns the same object, updated in place.
 */
export function migrateBusTypes(m: Model): Model {
  for (const b of m.buses as (BusSpec & Record<string, unknown>)[]) {
    const protocol = b.protocol;
    if (protocol === undefined) continue;
    delete b.protocol;
    if (protocol !== 'generic' && !b.type) {
      b.type = protocol;
      if (!(m.busTypes ?? []).some((t) => t.id === protocol)) {
        const t = templateCopy(protocol);
        if (t) (m.busTypes ??= []).push(t);
      }
    }
    if (protocol === 'pcie') {
      // The old defaults were Gen4 x4 and a 0.95 efficiency field.
      const gen = PCIE_GEN[b.gen ?? 4] ?? PCIE_GEN[4];
      b.vars = { lanes: b.lanes ?? 4, lane_rate: gen.rate, encoding: gen.encoding, ...(b.vars ?? {}) };
      if (b.efficiency !== undefined) {
        b.vars.link_efficiency = b.efficiency;
        delete b.efficiency;
      }
    }
    delete b.gen;
    delete b.lanes;
  }
  return m;
}
