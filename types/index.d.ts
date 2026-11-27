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

/** Generation speed of the local Ollama server, read from its log. */
export type Llm = {
  /** Models Ollama holds in memory now, without the `:latest` tag. */
  models: string[]
  /** True while a request is generating (a speed line newer than the last finished request). */
  generating: boolean
  /** Speed over the last 3 seconds of the request in progress, tokens per second. */
  liveTps: number | null
  /** Generation speed of the last finished request, tokens per second. */
  lastTps: number | null
  lastTokens: number | null
  /** Prompt reading speed of the last finished request, tokens per second. */
  promptTps: number | null
  /** Share of draft tokens accepted (speculative decoding), 0 to 100, when the model uses it. */
  draftPct: number | null
  /** Seconds since Ollama last wrote its log. */
  ageS: number
  /** Task id of the last finished request, so each request is counted once. */
  lastTask: string | null
  /** Last finished speed per model, kept across readings and model swaps. */
  byModel: Record<string, number>
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
  /** Null when Ollama has no log on this PC. */
  llm: Llm | null
  errors: ('host' | 'hostParse' | 'gpu')[]
}

declare module 'claude-code' {
  interface PluginState {
    sysload: { sample: Shaped<Sample | null> }
  }
}
