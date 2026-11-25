export type Drive = {
  letter: string
  usedPct: number
  freeGb: number
  sizeGb: number
  busyPct: number | null
}

export type Gpu = {
  utilPct: number
  vramUsedMb: number
  vramTotalMb: number
  tempC: number
  powerW: number
}

export type Sample = {
  at: string
  cpuPct: number | null
  ramUsedGb: number | null
  ramTotalGb: number | null
  gpu: Gpu | null
  drives: Drive[]
  gpuLock: string | null
  error: string | null
}

declare module 'claude-code' {
  interface PluginState {
    sysload: { sample: Shaped<Sample | null> }
  }
}
