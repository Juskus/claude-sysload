import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Drive, Gpu, Sample } from '../types'

const PANE = 'sysload'
const TITLE = 'Obciążenie PC'
const PERIOD_MS = 5000

// Change the tag when Sample's fields change: it declines what an earlier version stored.
const sample = atom({ plugin: 'sysload', key: 'sample' } as const, null, { shape: 'sample-1' })

// One PowerShell call per period: CPU, RAM, fixed drives, physical-disk busy time and the
// delegation setup's GPU lock. Printed as one JSON line.
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
  drives = $drives; lock = $lock
} | ConvertTo-Json -Compress -Depth 4
`

type Raw = {
  cpu?: number | null
  ramFreeKb?: number | null
  ramTotalKb?: number | null
  drives?: { letter: string; size: number; free: number; busy?: number | null }[] | null
  lock?: string | null
}

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

function parseHost(stdout: string): Omit<Sample, 'at' | 'gpu' | 'error'> {
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
  }
}

const level = (pct: number) => (pct >= 90 ? '#d9534f' : pct >= 70 ? '#e0a35c' : '#3fa66b')

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'sysload', description: 'Pokaż obciążenie CPU, RAM, GPU i dysków' })

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
        const errors: string[] = []
        let host: Omit<Sample, 'at' | 'gpu' | 'error'> = { cpuPct: null, ramUsedGb: null, ramTotalGb: null, drives: [], gpuLock: null }
        if (hostRun.status === 'fulfilled' && hostRun.value.exitCode === 0) {
          try { host = parseHost(hostRun.value.stdout) } catch { errors.push('CPU/RAM: nieczytelny wynik') }
        } else errors.push('CPU/RAM/dyski: brak odczytu')
        const gpu = gpuRun.status === 'fulfilled' && gpuRun.value.exitCode === 0 ? parseGpu(gpuRun.value.stdout) : null
        if (!gpu) errors.push('GPU: brak odczytu z nvidia-smi')
        const at = new Date().toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
        await update($, sample, () => ({ at, gpu, ...host, error: errors.length ? errors.join('; ') : null }))
      } finally {
        isBusy = false
      }
    }

    void poll()
    $.clock.every(PERIOD_MS, poll)
    void $.ui.open({ id: PANE, title: TITLE, placement: 'widget' })

    return next(e)
  })

  on('command.run', { command: 'sysload' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: TITLE })
    return { text: opened.isPlaced ? 'Panel obciążenia otwarty.' : `Panel czeka na miejsce: ${opened.reason}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Progress } = $.ui.resolve(e)
    const s = await read($, sample)
    const isWidget = e.props.placement === 'widget'

    if (!s) return <Text dimColor>Pierwszy odczyt…</Text>

    const bar = (label: string, pct: number | null, valueText: string) =>
      pct === null ? (
        <Text dimColor>{label}: brak danych</Text>
      ) : Progress ? (
        <Box flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between">
            <Text size="footnote">{label}</Text>
            <Text size="footnote" tabular>{valueText}</Text>
          </Box>
          <Progress label={label} value={pct} max={100} valueText={valueText} color={level(pct)} />
        </Box>
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

    return (
      <Box flexDirection="column" gap={1}>
        {core}
        <Text size="footnote" weight="semibold">Dyski</Text>
        {s.drives.map(d => (
          <Box flexDirection="row" justifyContent="space-between">
            <Text size="footnote" mono>{d.letter}</Text>
            <Text size="footnote" tabular color={level(d.usedPct)}>{d.usedPct}% zajęte</Text>
            <Text size="footnote" tabular dimColor>{d.freeGb} GB wolne</Text>
            <Text size="footnote" tabular>{d.busyPct === null ? '–' : `${d.busyPct}% pracy`}</Text>
          </Box>
        ))}
        <Text size="footnote" dimColor>
          Blokada GPU: {s.gpuLock === null ? 'wolna' : s.gpuLock === 'manual' ? 'trzymana ręcznie' : `zajęta (pid ${s.gpuLock})`}
        </Text>
        {s.error && <Text size="footnote" color="#d9534f">{s.error}</Text>}
        <Text size="caption" dimColor>Odczyt {s.at}, co {PERIOD_MS / 1000} s</Text>
      </Box>
    )
  })
}
