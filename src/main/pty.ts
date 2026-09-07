import { spawn, type IPty } from '@lydell/node-pty'
import { randomUUID } from 'crypto'
import { homedir } from 'os'
import { Ipc, type PtyCreateOptions, type PtyCreateResult } from '../shared/ipc'
import type { SessionOpenOptions, HostKeyPromptEvent, SshConnection } from '../shared/connections'
import { broadcast } from './broadcast'
import { connectSsh, type SshSessionHandle } from './ssh'
import type { HostKeyCheckResult } from './knownHosts'
import { configureSysinfo, registerSysinfoClient, stopPolling } from './sysinfo'
import { registerSftpClientProvider, closeSftp } from './sftp'
import { attachZmodem, detachZmodem, feedZmodem, isZmodemActive } from './zmodem'

// Re-export so the session-layer loopback bundle (tests/*-e2e.mjs) can drive the
// M3 polling engine without importing src/main/sysinfo.ts separately.
export { startPolling, stopPolling } from './sysinfo'

/**
 * M5 command-store / log-service hooks (injected once by ipc.ts). Mirrors the
 * sysinfo injection pattern so pty.ts routes PTY data into the session log
 * without importing the store directly. `log` runs on every onData chunk (the
 * logger itself decides whether a session is actively logging), `stop` runs on
 * session close / kill to finalize the log file.
 */
type DataLogger = (id: string, data: string) => void
let dataLogger: DataLogger | undefined
let logStopper: (id: string) => void | undefined

export function registerLogHooks(log: DataLogger, stop: (id: string) => void): void {
  dataLogger = log
  logStopper = stop
}

function safeLog(id: string, data: string): void {
  try {
    dataLogger?.(id, data)
  } catch {
    // never crash the event loop
  }
}

function safeStopLog(id: string): void {
  try {
    logStopper?.(id)
  } catch {
    // never crash the event loop
  }
}

/**
 * Session routing table. A session is either a local pty or an established ssh
 * shell; the generic PTY_* (data plane) channels address both. PTY_DATA /
 * PTY_EXIT broadcasts are identical for both kinds.
 */
type Session = { kind: 'local'; pty: IPty } | { kind: 'ssh'; ssh: SshSessionHandle }

/** The live ssh2 client behind an ssh session, or undefined. */
export function getSshClient(id: string): SshSessionHandle['client'] | undefined {
  const session = sessions.get(id)
  return session?.kind === 'ssh' ? session.ssh.client : undefined
}

const sessions = new Map<string, Session>()

/**
 * Per-session replay of recent output (capped). Late subscribers — a terminal
 * view mounting after the shell already printed its banner, or a panel rebound
 * by template apply — read this instead of losing the head of the stream.
 */
const REPLAY_CAP = 64 * 1024
const replayBuffers = new Map<string, string>()

function appendReplay(id: string, data: string): void {
  const prev = replayBuffers.get(id) ?? ''
  const next = prev.length + data.length > REPLAY_CAP
    ? (prev + data).slice(prev.length + data.length - REPLAY_CAP)
    : prev + data
  replayBuffers.set(id, next)
}

/** Recent output of a session ('' when unknown). */
export function getSessionReplay(id: string): string {
  return replayBuffers.get(id) ?? ''
}

/**
 * Dependencies injected once by ipc.ts (configureSessionRuntime) so pty.ts
 * stays free of store / known-hosts imports and the ssh service can remain
 * decoupled from Electron.
 */
export interface SessionRuntimeDeps {
  /** resolve a bookmark by id (throws a Chinese message when missing) */
  getConnection(connectionId: string): SshConnection
  /** decrypt a stored secret for a connection */
  getSecret(conn: SshConnection, field: 'password' | 'keyContent' | 'passphrase'): string | undefined
  /** mark a bookmark as recently connected */
  touch(connectionId: string): void
  /** host key pinning: check against the store, record an accepted key */
  knownHosts: {
    check(host: string, port: number, key: Buffer): HostKeyCheckResult
    accept(host: string, port: number, key: Buffer, fingerprint: string): void
  }
  /** ask the renderer to decide an unknown / changed host key */
  promptHostKey(prompt: HostKeyPromptEvent): void
  broadcast(channel: string, ...args: unknown[]): void
}

let runtimeDeps: SessionRuntimeDeps | undefined

/** Wire the real stores + renderer prompt. Called once during app startup. */
export function configureSessionRuntime(deps: SessionRuntimeDeps): void {
  runtimeDeps = deps
  configureSysinfo({
    broadcast: (channel, ...args) => deps.broadcast(channel, ...args)
  })
  registerSysinfoClient((id) => {
    const session = sessions.get(id)
    if (session?.kind === 'ssh') return session.ssh.client
    return undefined
  })
  registerSftpClientProvider((id) => {
    const session = sessions.get(id)
    if (session?.kind === 'ssh') return session.ssh.client
    return undefined
  })
}

function defaultShell(): string {
  switch (process.platform) {
    case 'win32':
      return 'powershell.exe'
    case 'darwin':
      return process.env.SHELL || '/bin/zsh'
    default:
      return process.env.SHELL || '/bin/bash'
  }
}

export function createPty(opts: PtyCreateOptions = {}): PtyCreateResult {
  const id = randomUUID()
  const shell = opts.shell ?? defaultShell()
  const cwd = opts.cwd ?? homedir()
  // Advertise color capability + terminal identity so TUIs (e.g. kimi CLI)
  // use their full-color theme instead of the degraded white/amber fallback.
  const env = {
    ...process.env,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'OpenTerminal',
    ...opts.env
  } as Record<string, string>

  const pty = spawn(shell, [], { name: 'xterm-256color', cols: 80, rows: 24, cwd, env })
  sessions.set(id, { kind: 'local', pty })
  replayBuffers.set(id, '')

  pty.onData((data) => {
    try {
      appendReplay(id, data)
      safeLog(id, data)
      broadcast(Ipc.PTY_DATA, { id, data })
    } catch {
      // never crash the event loop
    }
  })

  pty.onExit(({ exitCode }) => {
    try {
      sessions.delete(id)
      safeStopLog(id)
      broadcast(Ipc.PTY_EXIT, { id, exitCode })
    } catch {
      // never crash the event loop
    }
  })

  return { id, shell, cwd }
}

/**
 * Open a session. `local` reuses createPty; `ssh` goes through the ssh service
 * and resolves only once the shell stream is ready to stream data.
 */
export async function openSession(opts: SessionOpenOptions): Promise<{ id: string }> {
  if (opts.kind === 'local') {
    return { id: createPty().id }
  }

  const deps = runtimeDeps
  if (!deps) {
    throw new Error('SSH 会话服务尚未初始化')
  }
  if (!opts.connectionId) {
    throw new Error('SSH 会话缺少 connectionId')
  }

  const conn = deps.getConnection(opts.connectionId)
  const handle = await connectSsh(conn, opts.secretOverride, {
    connections: {
      getSecret: (c, field) => deps.getSecret(c, field),
      touch: (id: string) => {
        // Successful connect: record lastConnectedAt on the bookmark.
        try {
          deps.touch(id)
        } catch {
          // store write failure must not break the session
        }
      }
    },
    knownHosts: deps.knownHosts,
    broadcast: deps.broadcast,
    promptHostKey: deps.promptHostKey
  })
  sessions.set(handle.id, { kind: 'ssh', ssh: handle })

  // ZMODEM (M6): attach the in-process engine to the raw ssh stream. Only ssh
  // sessions are supported -- node-pty/Windows ConPTY hands out UTF-8 strings
  // only and would corrupt binary frames. The sentry inspects every data chunk:
  // non-ZMODEM traffic is routed back through toTerminal below; once a ZMODEM
  // header is spotted the transfer suppresses the terminal data plane (and
  // writePty drops user keystrokes while isZmodemActive is true).
  attachZmodem(handle.id, {
    broadcast: (channel, ...args) => deps.broadcast(channel, ...args),
    toTerminal: (id, text) => {
      appendReplay(id, text)
      safeLog(id, text)
      deps.broadcast(Ipc.PTY_DATA, { id, data: text })
    },
    writeStream: (id, data) => {
      const s = sessions.get(id)
      if (s?.kind === 'ssh') {
        try {
          s.ssh.stream.write(data)
        } catch {
          // stream may already be dead
        }
      }
    }
  })

  handle.stream.on('data', (data: Buffer) => {
    // Route through the ZMODEM sentry. It forwards non-ZMODEM bytes to
    // deps.toTerminal and absorbs the transfer untouched; while a transfer is
    // active the engine suppresses the normal data plane entirely.
    feedZmodem(handle.id, data)
  })

  handle.stream.on('close', () => {
    try {
      stopPolling(handle.id)
      closeSftp(handle.id)
      detachZmodem(handle.id)
      safeStopLog(handle.id)
      sessions.delete(handle.id)
      deps.broadcast(Ipc.PTY_EXIT, { id: handle.id, exitCode: 0 })
    } catch {
      // never crash the event loop
    }
  })

  return { id: handle.id }
}

export function writePty(id: string, data: string): void {
  // While a ZMODEM transfer is active the stream carries binary frames; user
  // keystrokes must be dropped (they would corrupt the transfer).
  if (isZmodemActive(id)) return
  const session = sessions.get(id)
  if (!session) return
  try {
    if (session.kind === 'local') session.pty.write(data)
    else session.ssh.stream.write(data)
  } catch {
    // session may already be dead
  }
}

export function resizePty(id: string, cols: number, rows: number): void {
  const session = sessions.get(id)
  if (!session) return
  try {
    if (session.kind === 'local') session.pty.resize(cols, rows)
    // ssh2 Channel.setWindow(rows, cols, height, width)
    else session.ssh.stream.setWindow(rows, cols, 0, 0)
  } catch {
    // session may already be dead
  }
}

export function killPty(id: string): void {
  stopPolling(id)
  closeSftp(id)
  detachZmodem(id)
  safeStopLog(id)
  replayBuffers.delete(id)
  const session = sessions.get(id)
  if (!session) return
  if (session.kind === 'ssh') {
    try {
      session.ssh.stream.close()
    } catch {
      // best effort
    }
    try {
      session.ssh.client.end()
    } catch {
      // best effort
    }
  } else {
    try {
      session.pty.kill()
    } catch {
      // best effort
    }
  }
  sessions.delete(id)
}

export function killAllPtys(): void {
  for (const id of sessions.keys()) {
    stopPolling(id)
    closeSftp(id)
    detachZmodem(id)
    safeStopLog(id)
    const session = sessions.get(id)
    if (!session) continue
    if (session.kind === 'ssh') {
      try {
        session.ssh.stream.close()
      } catch {
        // best effort
      }
      try {
        session.ssh.client.end()
      } catch {
        // best effort
      }
    } else {
      try {
        session.pty.kill()
      } catch {
        // best effort
      }
    }
  }
  sessions.clear()
}