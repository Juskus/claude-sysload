import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Drive, Gpu, Sample } from '../types'

const PANE = 'sysload'
const PERIOD_MS = 5000

// Change the tag when Sample's fields change: it declines what an earlier version stored.
const sample = atom({ plugin: 'sysload', key: 'sample' } as const, null, { shape: 'sample-2' })

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
// delegation setup's GPU lock and the system's culture. Printed as one JSON line.
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
if (Test-Path $lockDir) { $lock = (Get-Content (Join-Path $lockDir 'pid') -Raw); if (-not $lock) { $lock = '?' } }
[pscustomobject]@{
  cpu = $cpu; ramFreeKb = [double]$o.FreePhysicalMemory; ramTotalKb = [double]$o.TotalVisibleMemorySize
  drives = $drives; lock = $lock; locale = (Get-Culture).Name
} | ConvertTo-Json -Compress -Depth 4
`

type Raw = {
  cpu?: number | null
  ramFreeKb?: number | null
  ramTotalKb?: number | null
  drives?: { letter: string; size: number; free: number; busy?: number | null }[] | null
  lock?: string | null
  locale?: string | null
}

type Host = Pick<Sample, 'cpuPct' | 'ramUsedGb' | 'ramTotalGb' | 'drives' | 'gpuLock' | 'locale'>

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

function parseHost(stdout: string): Host {
  const raw = JSON.parse(stdout.trim()) as Raw
  const list = Array.isArray(raw.drives) ? raw.drives : raw.drives ? [raw.drives] : []
  const drives: Drive[] = list.map(d => ({
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
    gpuLock: raw.lock ? String(raw.lock).trim() : null,
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
        let host: Host = { cpuPct: null, ramUsedGb: null, ramTotalGb: null, drives: [], gpuLock: null, locale: previous?.locale ?? '' }
        if (hostRun.status === 'fulfilled' && hostRun.value.exitCode === 0) {
          try { host = parseHost(hostRun.value.stdout) } catch { errors.push('hostParse') }
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

    const core = (
      <Box flexDirection="column" gap={1}>
        {bar('CPU', s.cpuPct, `${s.cpuPct ?? '?'}%`)}
        {bar('RAM', ramPct, `${s.ramUsedGb ?? '?'} / ${s.ramTotalGb ?? '?'} GB`)}
        {bar('GPU', s.gpu ? s.gpu.utilPct : null, s.gpu ? `${s.gpu.utilPct}%  ${s.gpu.tempC}°C  ${s.gpu.powerW} W` : '')}
        {bar('VRAM', vramPct, s.gpu ? `${round1(s.gpu.vramUsedMb / 1024)} / ${round1(s.gpu.vramTotalMb / 1024)} GB` : '')}
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
        <Text size="footnote" dimColor>{t.lock}: {lock}</Text>
        {s.errors.length > 0 && <Text size="footnote" color="#d9534f">{s.errors.map(k => t.errors[k]).join('; ')}</Text>}
        <Text size="caption" dimColor>{t.reading(s.at, PERIOD_MS / 1000)}</Text>
      </Box>
    )
  })
}
