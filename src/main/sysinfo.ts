/**
 * Remote server hardware monitoring (M3): ssh sessions only.
 *
 * Polls a remote via an ssh2 `exec` (a single command returns CPU / memory /
 * load / uptime / disk / network in one transport), parses the cat'd /proc
 * files, diffs successive samples to compute usage and throughput, and
 * broadcasts SYSINFO_SAMPLE to every live window. SYSINFO_META (hostname + os)
 * is emitted once per session.
 *
 * The ssh `Client` for a session is injected by pty.ts (registerSysinfoClient);
 * the broadcast sink is injected by pty.ts at runtime configure time, so this
 * module stays Electron-free and testable through the same session-layer bundle
 * as the ssh harness.
 */

import { Ipc } from '../shared/ipc'
import type { Client } from 'ssh2'
import type { SysinfoMeta, SysinfoSample } from '../shared/sysinfo'

/** One exec returns stat+mem+load+uptime, then df, then net, then host/uname. */
const COLLECT_CMD =
  'cat /proc/stat /proc/meminfo /proc/loadavg /proc/uptime 2>/dev/null; ' +
  'echo __DF__; df -kP 2>/dev/null; ' +
  'echo __NET__; cat /proc/net/dev 2>/dev/null; ' +
  'echo __HOST__; hostname 2>/dev/null; uname -sr 2>/dev/null'

/** Failures this many in a row before auto-stopping the poll. */
const MAX_CONSECUTIVE_FAILS = 3

/** File-system types produced by `df -kP` that are not real disks. */
const FAKE_FS = new Set(['tmpfs', 'overlay', 'udev', 'devtmpfs', 'none', 'squashfs', 'shm'])
// Some df versions key the type column slightly differently; 'overlay'/'shm'
// are the common container hosts. sysfs/procfs never appear in df -kP.

/** Mirrors main/broadcast.ts but injectable so the loopback harness can capture it. */
interface SysinfoDeps {
  broadcast(channel: string, ...args: unknown[]): void
}

let deps: SysinfoDeps | undefined

/** Resolve an ssh `Client` for a session id (injected by pty.ts). */
type ClientProvider = (id: string) => Client | undefined
let clientProvider: ClientProvider | undefined

/** Wire the broadcast sink. Called once during app startup (from pty.ts). */
export function configureSysinfo(d: SysinfoDeps): void {
  deps = d
}

/** Register the session-id -> ssh client resolver (called by pty.ts). */
export function registerSysinfoClient(provider: ClientProvider): void {
  clientProvider = provider
}

interface Prev {
  /** cpu `idle`+`iowait` ticks from the previous sample */
  idle: number
  /** total ticks from the previous sample */
  total: number
  /** cumulative rx/tx bytes from the previous sample */
  rx: number
  tx: number
}

interface PollState {
  id: string
  intervalMs: number
  stopped: boolean
  consecutiveFails: number
  prev?: Prev
  /** most recent successful sample (kept for error frames) */
  lastSample?: SysinfoSample
  prevAt: number
  metaSent: boolean
  timer: NodeJS.Timeout
}

const polls = new Map<string, PollState>()

/**
 * Start polling a session. Calling again for the same id stops the previous
 * poll first (re-entrancy safe).
 */
export function startPolling(id: string, intervalMs = 3000): void {
  stopPolling(id)
  const state: PollState = {
    id,
    intervalMs,
    stopped: false,
    consecutiveFails: 0,
    prev: undefined,
    lastSample: undefined,
    prevAt: 0,
    metaSent: false,
    timer: setTimeout(() => pollOnce(id, state), 0)
  }
  polls.set(id, state)
}

/** Stop polling a session (no-op when not polling). Also run on session close. */
export function stopPolling(id: string): void {
  const state = polls.get(id)
  if (!state) return
  state.stopped = true
  clearTimeout(state.timer)
  polls.delete(id)
}

function armNext(id: string, state: PollState): void {
  if (state.stopped) return
  state.timer = setTimeout(() => pollOnce(id, state), state.intervalMs)
}

function pollOnce(id: string, state: PollState): void {
  if (state.stopped) return
  const client = clientProvider?.(id)
  if (!client) {
    handleError(id, state, 'SSH 会话不存在或已断开')
    return
  }

  try {
    client.exec(COLLECT_CMD, (err: Error | undefined, stream) => {
      if (state.stopped) return
      if (err || !stream) {
        handleError(id, state, err?.message || 'SSH exec 失败')
        return
      }
      let out = ''
      stream.on('data', (d: Buffer) => {
        out += d.toString('utf8')
      })
      const onEnd = (): void => {
        if (state.stopped) return
        try {
          stream.close()
        } catch {
          // best effort
        }
        handleOutput(id, state, out)
      }
      stream.on('close', onEnd)
      stream.on('error', () => onEnd())
    })
  } catch (err) {
    handleError(id, state, (err as Error).message)
  }
}

function handleError(id: string, state: PollState, message: string): void {
  if (state.stopped) return
  state.consecutiveFails += 1
  const last = state.lastSample
  const sample: SysinfoSample = last
    ? {
        ...last,
        ts: Date.now(),
        error: message
      }
    : {
        ts: Date.now(),
        cpu: { usage: 0, cores: 0, loadavg: [0, 0, 0] },
        mem: { totalMb: 0, usedMb: 0 },
        disks: [],
        net: { rxKbs: 0, txKbs: 0 },
        uptimeSec: 0,
        error: message
      }
  broadcastSample(id, sample)

  if (state.consecutiveFails >= MAX_CONSECUTIVE_FAILS) {
    console.warn(`[sysinfo] session ${id} failed ${state.consecutiveFails} polls, stopping`)
    stopPolling(id)
    return
  }
  armNext(id, state)
}

function handleOutput(id: string, state: PollState, out: string): void {
  if (state.stopped) return
  const now = Date.now()
  try {
    const parsed = parseOutput(out)
    const sample: SysinfoSample = {
      ts: now,
      cpu: parsed.cpu,
      mem: parsed.mem,
      disks: parsed.disks,
      net: parsed.net,
      uptimeSec: parsed.uptimeSec
    }
    state.consecutiveFails = 0

    // Diff against the previous sample when one exists and rates are computable.
    if (state.prev && state.prevAt > 0) {
      const dtSec = (now - state.prevAt) / 1000
      const totalDelta = parsed.cpuTotal - state.prev.total
      const idleDelta = parsed.cpuIdle - state.prev.idle
      if (totalDelta > 0) {
        sample.cpu.usage = Math.max(0, Math.min(100, 100 * (1 - idleDelta / totalDelta)))
      }
      if (dtSec > 0) {
        sample.net.rxKbs = Math.max(0, (parsed.netRx - state.prev.rx) / 1024 / dtSec)
        sample.net.txKbs = Math.max(0, (parsed.netTx - state.prev.tx) / 1024 / dtSec)
      }
    }
    state.prevAt = now
    state.prev = {
      idle: parsed.cpuIdle,
      total: parsed.cpuTotal,
      rx: parsed.netRx,
      tx: parsed.netTx
    }
    state.lastSample = sample
    broadcastSample(id, sample)

    if (!state.metaSent && (parsed.hostname || parsed.osInfo)) {
      state.metaSent = true
      broadcastMeta(id, { hostname: parsed.hostname, os: parsed.osInfo })
    }
  } catch (err) {
    handleError(id, state, `解析失败: ${(err as Error).message}`)
    return
  }
  armNext(id, state)
}

function broadcastSample(id: string, sample: SysinfoSample): void {
  try {
    deps?.broadcast(Ipc.SYSINFO_SAMPLE, { id, sample })
  } catch {
    // never crash the event loop
  }
}

function broadcastMeta(id: string, meta: SysinfoMeta): void {
  try {
    deps?.broadcast(Ipc.SYSINFO_META, { id, meta })
  } catch {
    // never crash the event loop
  }
}

// ---- parsing ------------------------------------------------------------------

interface Parsed {
  cpu: SysinfoSample['cpu']
  cpuIdle: number
  cpuTotal: number
  mem: SysinfoSample['mem']
  disks: SysinfoSample['disks']
  net: SysinfoSample['net']
  netRx: number
  netTx: number
  uptimeSec: number
  hostname: string
  osInfo: string
}

function parseOutput(raw: string): Parsed {
  // Split into the four delimited regions.
  const parts = raw.split(/__DF__|__NET__|__HOST__/)
  const procBlob = parts[0] ?? ''
  const dfBlob = parts[1] ?? ''
  const netBlob = parts[2] ?? ''
  const hostBlob = parts[3] ?? ''

  return {
    ...parseProc(procBlob),
    disks: parseDf(dfBlob),
    ...parseNet(netBlob),
    ...parseHost(hostBlob)
  }
}

function toNumber(s: string | undefined): number {
  const n = Number(s)
  return Number.isFinite(n) ? n : 0
}

function parseProc(blob: string): { cpu: SysinfoSample['cpu']; cpuIdle: number; cpuTotal: number; mem: SysinfoSample['mem']; uptimeSec: number } {
  const lines = blob.split('\n')
  let total = 0
  let idle = 0
  let cores = 0
  let user = 0
  const loadavg: [number, number, number] = [0, 0, 0]
  let memTotal = 0
  let memAvailable = 0
  let uptimeSec = 0

  for (const raw of lines) {
    const line = raw.trimEnd()
    if (line.startsWith('cpu')) {
      if (line.startsWith('cpu ')) {
        const f = line.split(/\s+/).slice(1).map(toNumber)
        user = f[0] ?? 0
        const nice = f[1] ?? 0
        const system = f[2] ?? 0
        const idleTicks = f[3] ?? 0
        const iowait = f[4] ?? 0
        const irq = f[5] ?? 0
        const softirq = f[6] ?? 0
        const steal = f[7] ?? 0
        const guest = f[8] ?? 0
        const guestNice = f[9] ?? 0
        idle = idleTicks + iowait
        total =
          user +
          nice +
          system +
          idle +
          irq +
          softirq +
          steal +
          guest +
          guestNice
      } else {
        cores += 1
      }
    } else if (line.startsWith('MemTotal:')) {
      memTotal = toNumber(line.split(/\s+/)[1])
    } else if (line.startsWith('MemAvailable:')) {
      memAvailable = toNumber(line.split(/\s+/)[1])
    } else if (line.includes('/')) {
      // /proc/loadavg: "0.00 0.01 0.05 1/234 5678"
      const loadMatch = /^\s*([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)/.exec(line)
      if (loadMatch) {
        loadavg[0] = toNumber(loadMatch[1])
        loadavg[1] = toNumber(loadMatch[2])
        loadavg[2] = toNumber(loadMatch[3])
      }
    } else if (/^\d/.test(line) && line.split(/\s+/).length === 2) {
      // /proc/uptime: "12345.67 9876.54"
      uptimeSec = toNumber(line.split(/\s+/)[0])
    }
  }

  return {
    cpu: {
      usage: 0,
      cores,
      loadavg
    },
    cpuIdle: idle,
    cpuTotal: total,
    mem: {
      // meminfo columns are kB; sample schema is MiB.
      totalMb: Math.round(memTotal / 1024),
      usedMb: memAvailable > 0 && memTotal >= memAvailable
        ? Math.round((memTotal - memAvailable) / 1024)
        : 0
    },
    uptimeSec: Math.round(uptimeSec)
  }
}

function parseDf(blob: string): SysinfoSample['disks'] {
  const disks: SysinfoSample['disks'] = []
  for (const raw of blob.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('Filesystem')) continue
    const f = line.split(/\s+/)
    if (f.length < 6) continue
    // Columns: Filesystem 1K-blocks Used Available Use% Mounted on
    const fs = f[0]
    const mount = f.slice(5).join(' ')
    // df -kP has no type column; pseudofs appear as the device name (tmpfs,
    // overlay, udev, ...) or as a mount point under the shared /dev harness.
    if (FAKE_FS.has(fs) || FAKE_FS.has(mount)) continue
    const totalKb = toNumber(f[1])
    const usedKb = toNumber(f[2])
    if (totalKb <= 0) continue
    disks.push({
      mount,
      totalMb: Math.round(totalKb / 1024),
      usedMb: Math.round(usedKb / 1024)
    })
  }
  return disks
}

function parseNet(
  blob: string
): { net: SysinfoSample['net']; netRx: number; netTx: number } {
  let rx = 0
  let tx = 0
  for (const raw of blob.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('Inter')) continue
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    const iface = line.slice(0, colon)
    const fields = line
      .slice(colon + 1)
      .trim()
      .split(/\s+/)
      .map(Number)
    // /proc/net/dev rows: rx_bytes rx_packets ... rx_multicast tx_bytes ...
    if (fields.length < 10 || fields.some((n) => !Number.isFinite(n))) continue
    if (iface === 'lo') continue
    rx += fields[0]
    tx += fields[8]
  }
  return { net: { rxKbs: 0, txKbs: 0 }, netRx: rx, netTx: tx }
}

function parseHost(blob: string): { hostname: string; osInfo: string } {
  const lines = blob.split('\n').map((l) => l.trim()).filter(Boolean)
  return {
    hostname: lines[0] ?? '',
    osInfo: lines.slice(1).join(' ').trim()
  }
}