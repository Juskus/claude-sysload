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
  /** The time of the reading, already formatted in the system's locale. */
  at: string
  /** The Windows culture name, such as `pl-PL` or `en-US`; empty when it could not be read. */
  locale: string
  cpuPct: number | null
  ramUsedGb: number | null
  ramTotalGb: number | null
  gpu: Gpu | null
  drives: Drive[]
  gpuLock: string | null
  errors: ('host' | 'hostParse' | 'gpu')[]
}

declare module 'claude-code' {
  interface PluginState {
    sysload: { sample: Shaped<Sample | null> }
  }
}
