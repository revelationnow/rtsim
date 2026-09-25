import type { Model } from '../model/types';

/** A minimal model to learn the concepts: two periodic tasks sharing a CPU and DDR. */
export const tutorial: Model = {
  name: 'Tutorial: two tasks, one bus',
  description:
    'A sensor task reads a buffer from DDR and filters it; a control loop runs every millisecond at higher priority. Try lowering bus_bw or raising sensor_kib and re-running.',
  params: {
    bus_bw: '3.2 GB/s',
    sensor_kib: 256,
  },
  processors: [
    { id: 'cpu', name: 'MCU core', freq: '400 MHz', cores: 1, policy: 'fixed-priority', preemptive: true, contextSwitch: '1 us' },
  ],
  memories: [{ id: 'ddr', name: 'DDR', size: '256 MiB', bandwidth: '4 GB/s', readLatency: '120 ns', writeLatency: '100 ns' }],
  buses: [{ id: 'axi', name: 'AXI', bandwidth: 'bus_bw', latency: '20 ns' }],
  dmas: [],
  links: [
    ['cpu', 'axi'],
    ['ddr', 'axi'],
  ],
  workplans: [
    {
      id: 'sensor',
      name: 'Sensor filter',
      priority: 1,
      deadline: '5 ms',
      trigger: { type: 'periodic', period: '5 ms', jitter: 'uniform(0, 100 us)' },
      steps: [
        { id: 'load', kind: 'transfer', from: 'ddr', to: 'cpu', bytes: 'sensor_kib * 1 KiB' },
        { id: 'filter', kind: 'compute', on: 'cpu', cycles: 'in_bytes * 4', after: ['load'] },
        { id: 'store', kind: 'transfer', from: 'cpu', to: 'ddr', bytes: '16 KiB', after: ['filter'] },
      ],
    },
    {
      id: 'control',
      name: 'Control loop',
      priority: 5,
      deadline: '1 ms',
      trigger: { type: 'periodic', period: '1 ms' },
      steps: [{ id: 'ctrl', kind: 'compute', on: 'cpu', cycles: 'normal(60000, 5000)' }],
    },
  ],
  sim: { duration: '100 ms', seed: 1 },
};

/**
 * A multi-camera ADAS SoC: ISP, NPU, DSP and a CPU cluster sharing LPDDR over a NoC, with a
 * radar chain on a peripheral bus and a camera/radar fusion join.
 */
export const adas: Model = {
  name: 'ADAS vision + radar fusion SoC',
  description:
    'Four 8 MP cameras at 30 fps go through the ISP into DDR; an NPU detector runs per frame; a radar chain runs on the DSP at 20 Hz; fusion joins the two on the CPU. Background CPU traffic and display scan-out load DDR. Sweep ddr_bw or npu_macs to find what the deadlines require.',
  params: {
    fps: 30,
    cameras: 4,
    frame_w: 3840,
    frame_h: 2160,
    bpp: 2,
    ddr_bw: '12.8 GB/s',
    npu_macs: 2048,
    model_gmacs: 3.5,
    weights: '6 MiB',
    act_spill: '12 MiB',
  },
  processors: [
    { id: 'cpu', name: 'CPU cluster', freq: '1.8 GHz', cores: 4, policy: 'fixed-priority', preemptive: true, contextSwitch: '2 us', maxOutstanding: 8, burst: 64 },
    { id: 'isp', name: 'ISP', freq: '800 MHz', cores: 1, policy: 'fifo' },
    { id: 'npu', name: 'NPU', freq: '1 GHz', cores: 1, policy: 'fifo', maxOutstanding: 64, burst: 128 },
    { id: 'dsp', name: 'Radar DSP', freq: '800 MHz', cores: 1, policy: 'fixed-priority', preemptive: true, contextSwitch: '500 ns' },
    { id: 'dpu', name: 'Display', freq: '300 MHz', cores: 1, policy: 'fifo' },
    { id: 'radar_fe', name: 'Radar front-end', freq: '200 MHz', cores: 1, policy: 'fifo' },
  ],
  memories: [
    { id: 'ddr', name: 'LPDDR4X', size: '4 GiB', bandwidth: 'ddr_bw', readLatency: '110 ns', writeLatency: '90 ns' },
    { id: 'sram', name: 'Shared SRAM', size: '4 MiB', bandwidth: '64 GB/s', readLatency: '8 ns', duplex: true },
    { id: 'tcm', name: 'DSP TCM', size: '512 KiB', bandwidth: '16 GB/s', readLatency: '2 ns' },
  ],
  buses: [
    { id: 'noc', name: 'Main NoC', width: '256 bit', freq: '800 MHz', efficiency: 0.8, latency: '25 ns', duplex: true },
    { id: 'periph', name: 'Peripheral AXI', width: '64 bit', freq: '200 MHz', efficiency: 0.9, latency: '40 ns' },
  ],
  dmas: [{ id: 'dma', name: 'System DMA', channels: 4, maxOutstanding: 16, burst: 64, policy: 'priority' }],
  links: [
    ['ddr', 'noc'],
    ['sram', 'noc'],
    ['cpu', 'noc'],
    ['isp', 'noc'],
    ['npu', 'noc'],
    ['dsp', 'noc'],
    ['dpu', 'noc'],
    ['dma', 'noc'],
    ['periph', 'noc'],
    ['radar_fe', 'periph'],
    ['dsp', 'tcm'],
  ],
  workplans: [
    {
      id: 'capture',
      name: 'Camera capture + ISP',
      priority: 8,
      deadline: '1 s / fps',
      trigger: { type: 'periodic', period: '1 s / fps', jitter: 'uniform(0, 200 us)' },
      steps: [
        { id: 'readout', kind: 'delay', time: 'frame_h * 3.7 us' },
        { id: 'isp_proc', kind: 'compute', on: 'isp', cycles: 'cameras * frame_w * frame_h / 4', after: ['readout'] },
        { id: 'wr_frame', kind: 'transfer', from: 'isp', to: 'ddr', bytes: 'cameras * frame_w * frame_h * bpp', after: ['isp_proc'] },
      ],
    },
    {
      id: 'detect',
      name: 'NPU object detection',
      priority: 5,
      deadline: '25 ms',
      maxInFlight: 1,
      onOverrun: 'skip',
      vars: { objects: 'round(clamp(normal(12, 5), 0, 64))' },
      trigger: { type: 'event', sources: ['capture'] },
      steps: [
        { id: 'load_in', kind: 'transfer', from: 'ddr', to: 'sram', via: 'dma', bytes: 'cameras * 640 * 384 * 3' },
        { id: 'weights', kind: 'transfer', from: 'ddr', to: 'npu', bytes: 'cameras * weights' },
        { id: 'infer', kind: 'compute', on: 'npu', cycles: 'cameras * model_gmacs * 1e9 / npu_macs / 0.7', after: ['load_in', 'weights'] },
        { id: 'spill', kind: 'transfer', from: 'npu', to: 'ddr', bytes: 'cameras * act_spill', after: ['load_in', 'weights'] },
        { id: 'store_out', kind: 'transfer', from: 'npu', to: 'ddr', bytes: 'objects * 64 B + 256 KiB', after: ['infer', 'spill'] },
        { id: 'nms', kind: 'compute', on: 'cpu', cycles: '150000 + objects^2 * 800', after: ['store_out'] },
      ],
    },
    {
      id: 'radar',
      name: 'Radar range-Doppler',
      priority: 7,
      deadline: '20 ms',
      trigger: { type: 'periodic', period: '50 ms', offset: '3 ms' },
      steps: [
        { id: 'adc', kind: 'transfer', from: 'radar_fe', to: 'sram', bytes: '256 * 128 * 4 * 2' },
        { id: 'to_tcm', kind: 'transfer', from: 'sram', to: 'tcm', via: 'dsp', bytes: '256 * 128 * 4 * 2', after: ['adc'] },
        { id: 'range_fft', kind: 'compute', on: 'dsp', cycles: '5 * 256 * log2(256) * 128 * 4 / 4', after: ['to_tcm'] },
        { id: 'doppler_fft', kind: 'compute', on: 'dsp', cycles: '5 * 128 * log2(128) * 256 * 4 / 4', after: ['range_fft'] },
        { id: 'cfar', kind: 'compute', on: 'dsp', cycles: '256 * 128 * 20 / 4', after: ['doppler_fft'] },
        { id: 'out', kind: 'transfer', from: 'tcm', to: 'ddr', via: 'dsp', bytes: '32 KiB', after: ['cfar'] },
      ],
    },
    {
      id: 'fusion',
      name: 'Camera/radar fusion',
      priority: 6,
      deadline: '10 ms',
      e2eDeadline: '80 ms',
      trigger: { type: 'event', sources: ['detect', 'radar'], mode: 'all', consume: 'latest' },
      steps: [
        { id: 'rd', kind: 'transfer', from: 'ddr', to: 'cpu', bytes: '96 KiB' },
        { id: 'track', kind: 'compute', on: 'cpu', cycles: 'clamp(normal(3e6, 3e5), 1e6, 6e6)', after: ['rd'] },
        { id: 'wr', kind: 'transfer', from: 'cpu', to: 'ddr', bytes: '16 KiB', after: ['track'] },
      ],
    },
    {
      id: 'control',
      name: 'Vehicle control loop',
      priority: 9,
      deadline: '1 ms',
      trigger: { type: 'periodic', period: '1 ms' },
      steps: [
        { id: 'rd', kind: 'transfer', from: 'ddr', to: 'cpu', bytes: '4 KiB' },
        { id: 'ctl', kind: 'compute', on: 'cpu', cycles: 'normal(150000, 10000)', after: ['rd'] },
      ],
    },
    {
      id: 'display',
      name: 'Display scan-out',
      priority: 4,
      deadline: '1 s / 60',
      trigger: { type: 'periodic', period: '1 s / 60' },
      steps: [{ id: 'scan', kind: 'transfer', from: 'ddr', to: 'dpu', bytes: '1920 * 1080 * 4' }],
    },
    {
      id: 'background',
      name: 'Background CPU traffic',
      priority: 0,
      trigger: { type: 'poisson', interval: '200 us' },
      steps: [{ id: 'memcpy', kind: 'transfer', from: 'ddr', to: 'cpu', bytes: 'exponential(256 KiB)' }],
    },
  ],
  sim: { duration: '500 ms', seed: 42 },
};

/** A tiled accelerator with ping-pong DMA buffers: shows pipelining through maxInFlight. */
export const pingpong: Model = {
  name: 'Tiled accelerator, ping-pong buffers',
  description:
    'A video encoder processes a frame as 64 tiles. Each tile is DMA-ed into SRAM, encoded and written back; two tiles may be in flight so DMA overlaps compute. Change tiles_in_flight to 1 to see the pipeline stall.',
  params: {
    tiles: 64,
    tile_bytes: '1920 * 1080 * 1.5 / 64 B',
    enc_cpb: 1.5,
    tiles_in_flight: 2,
  },
  processors: [
    { id: 'enc', name: 'Encoder core', freq: '600 MHz', cores: 1, policy: 'fifo', maxOutstanding: 16, burst: 128 },
    { id: 'host', name: 'Host CPU', freq: '1.2 GHz', cores: 2, policy: 'fixed-priority', preemptive: true, contextSwitch: '3 us' },
  ],
  memories: [
    { id: 'ddr', name: 'LPDDR', size: '1 GiB', bandwidth: '1.6 GB/s', readLatency: '100 ns', writeLatency: '80 ns' },
    { id: 'sram', name: 'Tile SRAM', size: '256 KiB', bandwidth: '32 GB/s', readLatency: '4 ns', duplex: true },
  ],
  buses: [{ id: 'axi', name: 'AXI', width: '128 bit', freq: '500 MHz', efficiency: 0.85, latency: '15 ns', duplex: true }],
  dmas: [{ id: 'dma', name: 'DMA', channels: 2, maxOutstanding: 8, burst: 64 }],
  links: [
    ['enc', 'axi'],
    ['host', 'axi'],
    ['ddr', 'axi'],
    ['sram', 'axi'],
    ['dma', 'axi'],
  ],
  workplans: [
    {
      id: 'frame',
      name: 'Frame start',
      priority: 3,
      deadline: '33 ms',
      trigger: { type: 'periodic', period: '1 s / 30' },
      steps: [{ id: 'setup', kind: 'compute', on: 'host', cycles: '200000' }],
    },
    {
      id: 'tile',
      name: 'Encode tile',
      priority: 2,
      e2eDeadline: '9 ms',
      maxInFlight: 'tiles_in_flight',
      onOverrun: 'queue',
      trigger: { type: 'event', sources: ['frame'], repeat: 'tiles' },
      steps: [
        { id: 'dma_in', kind: 'transfer', from: 'ddr', to: 'sram', via: 'dma', bytes: 'tile_bytes' },
        { id: 'encode', kind: 'compute', on: 'enc', cycles: 'tile_bytes / 1 B * enc_cpb * uniform(0.8, 1.2)', after: ['dma_in'] },
        { id: 'dma_out', kind: 'transfer', from: 'sram', to: 'ddr', via: 'dma', bytes: 'tile_bytes / 1 B * 0.1 * 1 B', after: ['encode'] },
      ],
    },
  ],
  sim: { duration: '200 ms', seed: 3 },
};

/**
 * A PCIe inference card: host memory over a PCIe link, a device NoC and an AXI control bus, all
 * simulated packet by packet. Bulk DMA shares the link and NoC with a latency-critical doorbell.
 */
export const pcieCard: Model = {
  name: 'PCIe inference accelerator',
  description:
    'A host feeds batches to an accelerator card over PCIe Gen4 x8. The device DMA pulls inputs from host memory with read requests of pcie_mrrs, returned as completions of pcie_completion bytes, the NPU runs from device DDR and SRAM, and results go back to the host. A 64 B doorbell from the host to the control CPU mailbox crosses the PCIe link, the NoC and the AXI control bus every 100 us with a 20 us deadline, contending with the bulk traffic packet by packet. Try pcie_completion = 64 B, or switch a bus to fluid to compare.',
  params: {
    batch: 16,
    npu_macs: 16384,
    dev_ddr_bw: '25.6 GB/s',
    pcie_completion: '128 B',
    pcie_mrrs: '4 KiB',
  },
  processors: [
    { id: 'host_cpu', name: 'Host CPU', freq: '3 GHz', cores: 8, policy: 'fixed-priority', preemptive: true, contextSwitch: '1 us', maxOutstanding: 16, burst: 64 },
    { id: 'npu', name: 'NPU', freq: '1.2 GHz', cores: 1, policy: 'fifo', maxOutstanding: 16, burst: 4096 },
    { id: 'ctrl_cpu', name: 'Control CPU', freq: '800 MHz', cores: 1, policy: 'fixed-priority', preemptive: true, contextSwitch: '400 ns', maxOutstanding: 4, burst: 64 },
  ],
  memories: [
    { id: 'host_ddr', name: 'Host DDR5', size: '64 GiB', bandwidth: '51.2 GB/s', readLatency: '90 ns', writeLatency: '70 ns' },
    { id: 'dev_ddr', name: 'Device LPDDR5', size: '16 GiB', bandwidth: 'dev_ddr_bw', readLatency: '110 ns', writeLatency: '90 ns' },
    { id: 'dev_sram', name: 'Device SRAM', size: '8 MiB', bandwidth: '128 GB/s', readLatency: '5 ns', duplex: true },
    { id: 'mailbox', name: 'Mailbox SRAM', size: '64 KiB', bandwidth: '4 GB/s', readLatency: '10 ns' },
  ],
  buses: [
    { id: 'host_bus', name: 'Host fabric', bandwidth: '64 GB/s', latency: '50 ns', duplex: true },
    { id: 'pcie', name: 'PCIe Gen4 x8', protocol: 'pcie', gen: 4, lanes: 8, latency: '300 ns', readPayload: 'pcie_completion', maxRequest: 'pcie_mrrs' },
    { id: 'dev_noc', name: 'Device NoC', protocol: 'noc', width: '256 bit', freq: '1 GHz', latency: '20 ns' },
    { id: 'dev_axi', name: 'Control AXI', protocol: 'axi', width: '32 bit', freq: '250 MHz', latency: '30 ns' },
  ],
  dmas: [{ id: 'dma', name: 'Device DMA', channels: 4, maxOutstanding: 32, burst: 4096, policy: 'priority' }],
  links: [
    ['host_cpu', 'host_bus'],
    ['host_ddr', 'host_bus'],
    ['host_bus', 'pcie'],
    ['pcie', 'dev_noc'],
    ['dev_noc', 'dev_ddr'],
    ['dev_noc', 'dev_sram'],
    ['dev_noc', 'npu'],
    ['dev_noc', 'dma'],
    ['dev_noc', 'dev_axi'],
    ['dev_axi', 'ctrl_cpu'],
    ['dev_axi', 'mailbox'],
  ],
  workplans: [
    {
      id: 'infer',
      name: 'Batch inference',
      priority: 5,
      deadline: '10 ms',
      maxInFlight: 2,
      onOverrun: 'queue',
      trigger: { type: 'periodic', period: '10 ms' },
      steps: [
        { id: 'h2d', kind: 'transfer', from: 'host_ddr', to: 'dev_ddr', via: 'dma', bytes: 'batch * 1920 * 1080 * 1.5 B' },
        { id: 'weights', kind: 'transfer', from: 'dev_ddr', to: 'npu', bytes: '24 MiB' },
        { id: 'compute', kind: 'compute', on: 'npu', cycles: 'batch * 4.1e9 / npu_macs / 0.6', after: ['h2d', 'weights'] },
        { id: 'spill', kind: 'transfer', from: 'npu', to: 'dev_sram', bytes: 'batch * 2 MiB', after: ['h2d', 'weights'] },
        { id: 'd2h', kind: 'transfer', from: 'dev_sram', to: 'host_ddr', via: 'dma', bytes: 'batch * 4 KiB', after: ['compute', 'spill'] },
      ],
    },
    {
      id: 'doorbell',
      name: 'Doorbell to control CPU',
      priority: 9,
      deadline: '20 us',
      trigger: { type: 'periodic', period: '100 us', offset: '7 us' },
      steps: [
        { id: 'ring', kind: 'transfer', from: 'host_cpu', to: 'mailbox', bytes: '64 B' },
        { id: 'handle', kind: 'compute', on: 'ctrl_cpu', cycles: 2000, after: ['ring'] },
        { id: 'ack', kind: 'transfer', from: 'ctrl_cpu', to: 'host_ddr', bytes: '16 B', after: ['handle'] },
      ],
    },
    {
      id: 'telemetry',
      name: 'Telemetry reads',
      priority: 1,
      trigger: { type: 'poisson', interval: '1 ms' },
      steps: [{ id: 'rd', kind: 'transfer', from: 'dev_ddr', to: 'ctrl_cpu', bytes: '4 KiB' }],
    },
    {
      id: 'host_bg',
      name: 'Host background traffic',
      priority: 0,
      trigger: { type: 'poisson', interval: '50 us' },
      steps: [{ id: 'copy', kind: 'transfer', from: 'host_ddr', to: 'host_cpu', bytes: 'exponential(64 KiB)' }],
    },
  ],
  sim: { duration: '100 ms', seed: 11 },
};

export const EXAMPLES: { key: string; model: Model }[] = [
  { key: 'adas', model: adas },
  { key: 'pcie', model: pcieCard },
  { key: 'tutorial', model: tutorial },
  { key: 'pingpong', model: pingpong },
];
