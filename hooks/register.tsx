import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Drive, Gpu, Llm, Sample } from '../types'

const PANE = 'sysload'
const PERIOD_MS = 5000

// Change the tag when Sample's fields change: it declines what an earlier version stored.
const sample = atom({ plugin: 'sysload', key: 'sample' } as const, null, { shape: 'sample-3' })

// Labels per language. The system's Windows culture picks one: Polish for pl-*, English otherwise.
const TEXT = {
  pl: {
    title: 'Obciążenie PC',
    first: 'Pierwszy odczyt…',
    noData: 'brak danych',
    disks: 'Dyski',
    used: 'zajęte',
    free: 'GB wolne',
    busy: 'pracy',
    lock: 'Blokada GPU',
    lockFree: 'wolna',
    lockManual: 'trzymana ręcznie',
    lockTaken: (pid: string) => `zajęta (pid ${pid})`,
    llm: 'Model lokalny',
    noModel: 'żaden model nie jest załadowany',
    generating: (tps: number) => `generuje ${tps} tok/s`,
    last: (tps: number, tokens: number | null, ago: string) => `ostatnio ${tps} tok/s${tokens ? ` (${tokens} tok.)` : ''}, ${ago} temu`,
    prompt: (tps: number) => `wczytanie promptu ${tps} tok/s`,
    draft: (pct: number) => `przyjęte tokeny szkicu ${pct}%`,
    byModel: 'Ostatnie tempo modeli',
    reading: (at: string, s: number) => `Odczyt ${at}, co ${s} s`,
    opened: 'Panel obciążenia otwarty.',
    waits: (reason: string) => `Panel czeka na miejsce: ${reason}`,
    langSet: (l: string) => `Język panelu: ${l}.`,
    usage: 'Użycie: /sysload [lang auto|pl|en]',
    errors: { host: 'CPU/RAM/dyski: brak odczytu', hostParse: 'CPU/RAM: nieczytelny wynik', gpu: 'GPU: brak odczytu z nvidia-smi' },
  },
  en: {
    title: 'PC load',
    first: 'First reading…',
    noData: 'no data',
    disks: 'Disks',
    used: 'used',
    free: 'GB free',
    busy: 'busy',
    lock: 'GPU lock',
    lockFree: 'free',
    lockManual: 'held by hand',
    lockTaken: (pid: string) => `taken (pid ${pid})`,
    llm: 'Local model',
    noModel: 'no model loaded',
    generating: (tps: number) => `generating ${tps} tok/s`,
    last: (tps: number, tokens: number | null, ago: string) => `last ${tps} tok/s${tokens ? ` (${tokens} tok.)` : ''}, ${ago} ago`,
    prompt: (tps: number) => `prompt read ${tps} tok/s`,
    draft: (pct: number) => `draft tokens accepted ${pct}%`,
    byModel: 'Last speed per model',
    reading: (at: string, s: number) => `Read at ${at}, every ${s} s`,
    opened: 'Load pane opened.',
    waits: (reason: string) => `The pane waits for room: ${reason}`,
    langSet: (l: string) => `Pane language: ${l}.`,
    usage: 'Usage: /sysload [lang auto|pl|en]',
    errors: { host: 'CPU/RAM/disks: no reading', hostParse: 'CPU/RAM: unreadable output', gpu: 'GPU: no reading from nvidia-smi' },
  },
} as const

// The person's choice, kept across sessions: 'auto' follows the Windows culture.
type Lang = 'auto' | 'pl' | 'en'
const LANG_KEY = 'lang'
let lang: Lang = 'auto' // mirrors the store, loaded at session start

const textFor = (locale: string | undefined) =>
  lang === 'pl' ? TEXT.pl : lang === 'en' ? TEXT.en : /^pl\b/i.test(locale ?? '') ? TEXT.pl : TEXT.en
const localeFor = (locale: string) => (lang === 'pl' ? 'pl-PL' : lang === 'en' ? 'en-US' : locale)

// One PowerShell call per period: CPU, RAM, fixed drives, physical-disk busy time, the
// delegation setup's GPU lock, the local Ollama server's speed lines and the system's culture.
// Printed as one JSON line. Ollama's log is read shared (the server keeps it open), last 128 KB only.
const PS = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$o = Get-CimInstance Win32_OperatingSystem
$cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
$busy = @{}
Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk | Where-Object Name -ne '_Total' | ForEach-Object {
  $b = [math]::Max(0, [math]::Min(100, 100 - [double]$_.PercentIdleTime))
  foreach ($l in ([regex]::Matches($_.Name, '[A-Z]:') | ForEach-Object { $_.Value })) { $busy[$l] = $b }
}
$drives = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Where-Object Size -gt 0 | ForEach-Object {
  [pscustomobject]@{ letter = $_.DeviceID; size = [double]$_.Size; free = [double]$_.FreeSpace; busy = $busy[$_.DeviceID] }
})
$lockDir = Join-Path $env:USERPROFILE '.claude\local\.gpu.lock'
$lock = $null
if (Test-Path $lockDir) { $lock = [string](Get-Content (Join-Path $lockDir 'pid') -Raw); if (-not $lock) { $lock = '?' } }
$llm = $null
$log = Join-Path $env:LOCALAPPDATA 'Ollama\server.log'
if (Test-Path $log) {
  $fi = Get-Item $log
  $fs = [IO.File]::Open($log, 'Open', 'Read', 'ReadWrite, Delete')
  try {
    $n = [int][math]::Min(131072, $fs.Length); [void]$fs.Seek(-$n, 'End')
    $buf = New-Object byte[] $n; $got = $fs.Read($buf, 0, $n)
  } finally { $fs.Dispose() }
  $lines = @([Text.Encoding]::UTF8.GetString($buf, 0, $got) -split "\r?\n" | Where-Object { $_ -match 'print_timing' } | Select-Object -Last 30)
  $models = @()
  try { $models = @((Invoke-RestMethod 'http://127.0.0.1:11434/api/ps' -TimeoutSec 1).models | ForEach-Object { [string]$_.name }) } catch {}
  $llm = [pscustomobject]@{ ageS = [int]((Get-Date) - $fi.LastWriteTime).TotalSeconds; lines = $lines; models = $models }
}
[pscustomobject]@{
  cpu = $cpu; ramFreeKb = [double]$o.FreePhysicalMemory; ramTotalKb = [double]$o.TotalVisibleMemorySize
  drives = $drives; lock = $lock; llm = $llm; locale = (Get-Culture).Name
} | ConvertTo-Json -Compress -Depth 4
`

type Raw = {
  cpu?: number | null
  ramFreeKb?: number | null
  ramTotalKb?: number | null
  drives?: { letter: string; size: number; free: number; busy?: number | null }[] | null
  lock?: string | { value?: string } | null
  llm?: { ageS?: number; lines?: string[] | string | null; models?: string[] | string | null } | null
  locale?: string | null
}

type Host = Pick<Sample, 'cpuPct' | 'ramUsedGb' | 'ramTotalGb' | 'drives' | 'gpuLock' | 'llm' | 'locale'>

const GB = 1024 ** 3
const round1 = (n: number) => Math.round(n * 10) / 10

function parseGpu(stdout: string): Gpu | null {
  const line = stdout.trim().split(/\r?\n/)[0] ?? ''
  const [util, used, total, temp, power] = line.split(',').map(s => Number(s.trim()))
  if (util === undefined || used === undefined || total === undefined || temp === undefined || power === undefined) return null
  if (![util, used, total].every(Number.isFinite) || total <= 0) return null
  return {
    utilPct: util,
    vramUsedMb: used,
    vramTotalMb: total,
    tempC: Number.isFinite(temp) ? Math.round(temp) : 0,
    powerW: Number.isFinite(power) ? Math.round(power) : 0,
  }
}

// PowerShell prints a one-item array as the item itself, and an empty one as null.
const list = <T,>(v: T[] | T | null | undefined): T[] => (Array.isArray(v) ? v : v == null ? [] : [v])
const num = (m: RegExpMatchArray | null | undefined) => (m ? Number(m[1]) : null)
const taskOf = (line: string) => line.match(/\| task (\d+) \|/)?.[1] ?? null

// Ollama's llama.cpp runner writes, per request: `n_gen = …, tg_3s = X t/s` while generating, then
// `prompt eval time = … (… Y tokens per second)`, `eval time = … / N tokens (… Z tokens per second)`,
// `total time = …` and, with speculative decoding, `draft acceptance = 0.6…`.
function parseLlm(raw: NonNullable<Raw['llm']>, previous: Llm | null): Llm {
  const lines = list(raw.lines)
  const models = list(raw.models).map(m => String(m).replace(/:latest$/, ''))
  const ageS = typeof raw.ageS === 'number' ? raw.ageS : 0
  const lastIdx = (re: RegExp) => lines.reduce((at, l, i) => (re.test(l) ? i : at), -1)
  const liveIdx = lastIdx(/tg_3s =/)
  const totalIdx = lastIdx(/total time =/)
  const generating = liveIdx > totalIdx && ageS < 15
  const lastTask = totalIdx >= 0 ? taskOf(lines[totalIdx]!) : null
  const ofTask = lastTask ? lines.filter(l => taskOf(l) === lastTask) : []
  const evalLine = ofTask.find(l => /\|\s+eval time =/.test(l))
  const lastTps = num(evalLine?.match(/([\d.]+) tokens per second/))
  const draft = num(ofTask.find(l => /draft acceptance =/.test(l))?.match(/draft acceptance = ([\d.]+)/))
  // A finished request is credited to the model only when exactly one is loaded.
  const byModel = { ...(previous?.byModel ?? {}) }
  if (lastTask && lastTask !== previous?.lastTask && lastTps !== null && models.length === 1) byModel[models[0]!] = Math.round(lastTps)
  return {
    models,
    generating,
    liveTps: generating ? num(lines[liveIdx]!.match(/tg_3s =\s*([\d.]+)/)) : null,
    lastTps: lastTps === null ? null : Math.round(lastTps),
    lastTokens: num(evalLine?.match(/\/\s*(\d+) tokens/)),
    promptTps: num(ofTask.find(l => /prompt eval time =/.test(l))?.match(/([\d.]+) tokens per second/)),
    draftPct: draft === null ? null : Math.round(draft * 100),
    ageS,
    lastTask,
    byModel,
  }
}

function parseHost(stdout: string, previousLlm: Llm | null): Host {
  const raw = JSON.parse(stdout.trim()) as Raw
  const drives: Drive[] = list(raw.drives).map(d => ({
    letter: d.letter,
    usedPct: Math.round((1 - d.free / d.size) * 100),
    freeGb: Math.round(d.free / GB),
    sizeGb: Math.round(d.size / GB),
    busyPct: typeof d.busy === 'number' ? Math.round(d.busy) : null,
  }))
  const totalKb = raw.ramTotalKb ?? null
  const freeKb = raw.ramFreeKb ?? null
  return {
    cpuPct: typeof raw.cpu === 'number' ? Math.round(raw.cpu) : null,
    ramUsedGb: totalKb && freeKb !== null ? round1((totalKb - freeKb) / 1024 ** 2) : null,
    ramTotalGb: totalKb ? round1(totalKb / 1024 ** 2) : null,
    drives,
    // Before 0.4.0 the script printed PowerShell's string wrapper ({ value, PSPath, … }) here.
    gpuLock: raw.lock ? String(typeof raw.lock === 'object' ? raw.lock.value ?? '?' : raw.lock).trim() : null,
    llm: raw.llm ? parseLlm(raw.llm, previousLlm) : null,
    locale: typeof raw.locale === 'string' ? raw.locale : '',
  }
}

function clockTime(locale: string): string {
  const options = { hour: '2-digit', minute: '2-digit', second: '2-digit' } as const
  try {
    return new Date().toLocaleTimeString(locale || undefined, options)
  } catch {
    return new Date().toLocaleTimeString(undefined, options) // a culture name Intl does not know
  }
}

const ago = (s: number) => (s < 60 ? `${s} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`)

const level = (pct: number) => (pct >= 90 ? '#d9534f' : pct >= 70 ? '#e0a35c' : '#3fa66b')

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'sysload', description: 'Show CPU, RAM, GPU and disk load / Pokaż obciążenie CPU, RAM, GPU i dysków' })
    const stored = await $.store.get(LANG_KEY)
    lang = stored === 'pl' || stored === 'en' ? stored : 'auto'

    let isBusy = false
    const poll = async () => {
      if (isBusy) return // a slow sample must not pile up behind the next one
      isBusy = true
      try {
        const [gpuRun, hostRun] = await Promise.allSettled([
          $.process.run(
            ['nvidia-smi', '--query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw', '--format=csv,noheader,nounits'],
            { timeoutMs: 4000 },
          ),
          $.process.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', PS], { timeoutMs: 8000 }),
        ])
        const previous = await read($, sample)
        const errors: Sample['errors'] = []
        let host: Host = { cpuPct: null, ramUsedGb: null, ramTotalGb: null, drives: [], gpuLock: null, llm: previous?.llm ?? null, locale: previous?.locale ?? '' }
        if (hostRun.status === 'fulfilled' && hostRun.value.exitCode === 0) {
          try { host = parseHost(hostRun.value.stdout, previous?.llm ?? null) } catch { errors.push('hostParse') }
        } else errors.push('host')
        const gpu = gpuRun.status === 'fulfilled' && gpuRun.value.exitCode === 0 ? parseGpu(gpuRun.value.stdout) : null
        if (!gpu) errors.push('gpu')
        await update($, sample, () => ({ at: clockTime(localeFor(host.locale)), gpu, ...host, errors }))
      } finally {
        isBusy = false
      }
    }

    // Open after the first reading, so the pane is titled in the system's language.
    void poll().then(async () => {
      const s = await read($, sample)
      await $.ui.open({ id: PANE, title: textFor(s?.locale).title, placement: 'widget' })
    })
    $.clock.every(PERIOD_MS, poll)

    return next(e)
  })

  on('command.run', { command: 'sysload' }, async ($, e) => {
    const words = e.args.trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (words[0] === 'lang') {
      const choice = words[1]
      if (choice !== 'auto' && choice !== 'pl' && choice !== 'en') return { text: textFor((await read($, sample))?.locale).usage }
      lang = choice
      await $.store.set(LANG_KEY, choice)
      // Rewrite the reading so the pane redraws now, its clock in the new language.
      await update($, sample, s => (s ? { ...s, at: clockTime(localeFor(s.locale)) } : s))
      const t = textFor((await read($, sample))?.locale)
      await $.ui.open({ id: PANE, title: t.title })
      return { text: t.langSet(choice) }
    }
    if (words.length > 0) return { text: textFor((await read($, sample))?.locale).usage }

    const t = textFor((await read($, sample))?.locale)
    const opened = await $.ui.open({ id: PANE, title: t.title })
    return { text: opened.isPlaced ? t.opened : t.waits(opened.reason) }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Progress } = $.ui.resolve(e)
    const s = await read($, sample)
    const t = textFor(s?.locale)
    const isWidget = e.props.placement === 'widget'

    if (!s) return <Text dimColor>{t.first}</Text>

    const bar = (label: string, pct: number | null, valueText: string) =>
      pct === null ? (
        <Text dimColor>{label}: {t.noData}</Text>
      ) : Progress ? (
        // Progress draws its own label and value text above the bar.
        <Progress label={label} value={pct} max={100} valueText={valueText} color={level(pct)} />
      ) : (
        <Text tabular>{label} {valueText}</Text>
      )

    const ramPct = s.ramUsedGb !== null && s.ramTotalGb ? Math.round((s.ramUsedGb / s.ramTotalGb) * 100) : null
    const vramPct = s.gpu ? Math.round((s.gpu.vramUsedMb / s.gpu.vramTotalMb) * 100) : null

    const llm = s.llm
    const model = llm?.models.join(', ') || null
    const speed = !llm
      ? null
      : llm.generating && llm.liveTps !== null
        ? t.generating(Math.round(llm.liveTps))
        : llm.lastTps !== null
          ? t.last(llm.lastTps, llm.lastTokens, ago(llm.ageS))
          : null
    const llmLine = llm && (
      <Text tabular color={llm.generating ? '#3fa66b' : undefined}>
        {t.llm}: {model ?? t.noModel}{speed ? ` · ${speed}` : ''}
      </Text>
    )

    const core = (
      <Box flexDirection="column" gap={1}>
        {bar('CPU', s.cpuPct, `${s.cpuPct ?? '?'}%`)}
        {bar('RAM', ramPct, `${s.ramUsedGb ?? '?'} / ${s.ramTotalGb ?? '?'} GB`)}
        {bar('GPU', s.gpu ? s.gpu.utilPct : null, s.gpu ? `${s.gpu.utilPct}%  ${s.gpu.tempC}°C  ${s.gpu.powerW} W` : '')}
        {bar('VRAM', vramPct, s.gpu ? `${round1(s.gpu.vramUsedMb / 1024)} / ${round1(s.gpu.vramTotalMb / 1024)} GB` : '')}
        {llmLine}
      </Box>
    )

    if (isWidget) return core

    const lock = s.gpuLock === null ? t.lockFree : s.gpuLock === 'manual' ? t.lockManual : t.lockTaken(s.gpuLock)

    return (
      <Box flexDirection="column" gap={1}>
        {core}
        <Text size="footnote" weight="semibold">{t.disks}</Text>
        {s.drives.map(d => (
          <Box flexDirection="row" justifyContent="space-between">
            <Text size="footnote" mono>{d.letter}</Text>
            <Text size="footnote" tabular color={level(d.usedPct)}>{d.usedPct}% {t.used}</Text>
            <Text size="footnote" tabular dimColor>{d.freeGb} {t.free}</Text>
            <Text size="footnote" tabular>{d.busyPct === null ? '–' : `${d.busyPct}% ${t.busy}`}</Text>
          </Box>
        ))}
        {llm && !llm.generating && (llm.promptTps !== null || llm.draftPct !== null) && (
          <Text size="footnote" tabular dimColor>
            {[llm.promptTps !== null ? t.prompt(Math.round(llm.promptTps)) : null, llm.draftPct !== null ? t.draft(llm.draftPct) : null]
              .filter(Boolean)
              .join(' · ')}
          </Text>
        )}
        {llm && Object.keys(llm.byModel).length > 0 && (
          <Box flexDirection="column">
            <Text size="footnote" weight="semibold">{t.byModel}</Text>
            {Object.entries(llm.byModel).map(([name, tps]) => (
              <Box flexDirection="row" justifyContent="space-between">
                <Text size="footnote" mono>{name}</Text>
                <Text size="footnote" tabular>{tps} tok/s</Text>
              </Box>
            ))}
          </Box>
        )}
        <Text size="footnote" dimColor>{t.lock}: {lock}</Text>
        {s.errors.length > 0 && <Text size="footnote" color="#d9534f">{s.errors.map(k => t.errors[k]).join('; ')}</Text>}
        <Text size="caption" dimColor>{t.reading(s.at, PERIOD_MS / 1000)}</Text>
      </Box>
    )
  })
}
