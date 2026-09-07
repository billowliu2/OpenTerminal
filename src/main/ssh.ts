/**
 * SSH session service (M2).
 *
 * Deliberately decoupled from Electron: broadcast and host-key store are
 * injected (`SshServiceDeps`), so the connect / verify / shell flow can be
 * exercised by the pure-node loopback harness (tests/ssh-loopback.mjs) with a
 * plain ssh2 client and no Chromium runtime.
 *
 * Host-key verification pauses the handshake inside the `hostVerifier`
 * callback: ssh2's kex suspends until `verify()` is called, which is exactly
 * what we need for store-check + renderer prompt + accept-record. The 15s
 * connect timeout is paused while a host-key prompt is outstanding so the
 * prompt's own 30s budget governs that wait.
 */

import type { SshConnection, SshSecretOverride } from '../shared/connections'
import { Ipc } from '../shared/ipc'
import { randomUUID } from 'crypto'
import { readFileSync } from 'fs'
import { fingerprintOf, type HostKeyCheckResult } from './knownHosts'
import type { ConnectionsStore } from './connectionsStore'
import type { Client, ClientChannel, ConnectConfig } from 'ssh2'

export interface SshSessionHandle {
  id: string
  /** established ssh connection; powers the session routing in pty.ts */
  client: Client
  /** open interactive shell channel (ClientChannel, a Duplex) */
  stream: ClientChannel
}

export interface SshServiceDeps {
  /** resolves saved secrets (service never writes them) */
  connections: Pick<ConnectionsStore, 'getSecret' | 'touch'>
  /** host key pinning store access */
  knownHosts: {
    check(host: string, port: number, key: Buffer): HostKeyCheckResult
    accept(host: string, port: number, key: Buffer, fingerprint: string): void
  }
  /** electron-free broadcast; matches main/broadcast.ts */
  broadcast(channel: string, ...args: unknown[]): void
  /**
   * Ask the renderer to decide on an unknown / changed host key. The prompt
   * resolves via the module-level `resolveHostKey(promptId, action)`.
   */
  promptHostKey(prompt: {
    promptId: string
    host: string
    port: number
    fingerprint: string
    reason: 'new' | 'changed'
  }): void
  timeoutMs?: { prompt: number; connect: number }
}

// Host-key confirmation is a security decision — users may take time to
// compare fingerprints. 30s timed out on people who merely screenshot it.
const DEFAULT_TIMEOUTS = { prompt: 120_000, connect: 15_000 }

/**
 * Open an ssh session (connect + auth + open shell) for `conn`.
 *
 * Resolves with `{ id, client, stream }` once the shell stream is ready to
 * stream data. Rejects with a human-readable Chinese Error when anything goes
 * wrong before the shell is ready.
 */
export async function connectSsh(
  conn: SshConnection,
  secretOverride: SshSecretOverride | undefined,
  deps: SshServiceDeps
): Promise<SshSessionHandle> {
  const mod = await import('ssh2')
  const Client = mod.Client
  const timeouts = { ...DEFAULT_TIMEOUTS, ...deps.timeoutMs }

  const sessionId = randomUUID()
  const handshake = new Client()

  let settled = false
  let connectTimer: NodeJS.Timeout | undefined
  let verifierErr: string | undefined
  let resolvePromise!: (handle: SshSessionHandle) => void
  let rejectPromise!: (err: Error) => void

  const armConnectTimer = (): void => {
    if (connectTimer) clearTimeout(connectTimer)
    connectTimer = setTimeout(() => {
      fail(new Error(`连接超时 (${conn.host}:${conn.port})`))
    }, timeouts.connect)
  }

  const fail = (err: Error): void => {
    if (settled) return
    settled = true
    if (connectTimer) clearTimeout(connectTimer)
    rejectPromise(err)
    try {
      handshake.destroy()
    } catch {
      // best effort
    }
  }

  // --- host key verification ------------------------------------------------
  // Called by ssh2 during kex; return undefined => async verdict via verify().
  const hostVerifier = (hostKey: Buffer, verify: (permitted: boolean) => void): void => {
    let fingerprint: string
    let status: 'new' | 'changed' | 'match'
    try {
      fingerprint = fingerprintOf(hostKey)
      status = deps.knownHosts.check(conn.host, conn.port, hostKey).status
    } catch (err) {
      console.error(`[ssh] knownHosts.check threw: ${(err as Error).message}`)
      fingerprint = fingerprintOf(hostKey)
      status = 'new'
    }

    if (status === 'match') {
      verify(true)
      return
    }

    // Pause the connect timeout; the user's decision owns this wait.
    if (connectTimer) clearTimeout(connectTimer)

    promptUser(conn.host, conn.port, fingerprint, status, timeouts.prompt, deps)
      .then((accepted) => {
        if (accepted) {
          try {
            deps.knownHosts.accept(conn.host, conn.port, hostKey, fingerprint)
          } catch (err) {
            verifierErr = `保存主机指纹失败: ${(err as Error).message}`
            verify(false)
            return
          }
          verify(true)
        } else {
          verifierErr = '用户拒绝了主机指纹'
          verify(false)
        }
      })
      .finally(() => {
        // Resume the overall connect timer once the decision lands.
        if (!settled) armConnectTimer()
      })
  }

  return new Promise<SshSessionHandle>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject

    // failure paths before resolution: `fail` and the connect timer
    armConnectTimer()

    handshake.on('error', (err: Error) => {
      console.error(`[ssh] client error: ${err.message}`)
      const message = verifierErr ?? err.message
      if (!settled) {
        fail(new Error(`连接失败 ${conn.host}:${conn.port}: ${message}`))
        return
      }
      // Session already established: surface as a session exit and clean up.
      try {
        deps.broadcast(Ipc.PTY_EXIT, { id: sessionId, exitCode: 1 })
      } catch {
        // never crash the event loop
      }
      try {
        handshake.destroy()
      } catch {
        // best effort
      }
    })

    handshake.on('ready', () => {
      handshake.shell(
        { term: 'xterm-256color', cols: 80, rows: 24 },
        (err: Error | undefined, shell: ClientChannel) => {
          if (err) {
            fail(new Error(`无法打开 SSH shell (${conn.host}:${conn.port}): ${err.message}`))
            return
          }
          if (settled) {
            try {
              shell.end()
            } catch {
              // best effort
            }
            return
          }
          settled = true
          if (connectTimer) clearTimeout(connectTimer)
          // Successful connect: record lastConnectedAt on the bookmark.
          try {
            deps.connections.touch(conn.id)
          } catch {
            // store write failure must not break the session
          }
          resolvePromise({ id: sessionId, client: handshake, stream: shell })
        }
      )
    })

    const cfg: ConnectConfig = {
      host: conn.host,
      port: conn.port,
      username: conn.username,
      // SshConnection keeps it in seconds; ssh2 expects milliseconds.
      keepaliveInterval: Math.round(conn.keepaliveIntervalSec * 1000),
      hostVerifier
    }

    // Password auth
    const password = secretOverride?.password ?? deps.connections.getSecret(conn, 'password')
    if (password !== undefined) cfg.password = password

    // Private key auth (keyPath takes precedence over stored keyContent)
    if (conn.auth === 'privateKey') {
      const keyContent = deps.connections.getSecret(conn, 'keyContent')
      const privateKey: string | undefined =
        conn.keyPath !== undefined && conn.keyPath.length > 0
          ? readKeyFile(conn.keyPath)
          : keyContent !== undefined && keyContent.length > 0
            ? keyContent
            : undefined
      if (privateKey !== undefined) {
        cfg.privateKey = privateKey
        const passphrase = secretOverride?.passphrase ?? deps.connections.getSecret(conn, 'passphrase')
        if (passphrase !== undefined) cfg.passphrase = passphrase
      }
    }

    // Agent auth (defaults supplied only when an agent socket is reachable)
    if (conn.auth === 'agent') {
      const agent = process.env.SSH_AUTH_SOCK ?? (process.platform === 'win32' ? 'pageant' : undefined)
      if (agent !== undefined) cfg.agent = agent
    }

    try {
      handshake.connect(cfg)
    } catch (err) {
      // e.g. unparseable privateKey is thrown synchronously by ssh2
      fail(new Error(`SSH 连接初始化失败 (${conn.host}:${conn.port}): ${(err as Error).message}`))
    }
  })
}

// --- host-key prompt routing -------------------------------------------------

interface PendingPrompt {
  resolve: (accepted: boolean) => void
  timer: NodeJS.Timeout
}

const pendingPrompts = new Map<string, PendingPrompt>()

/**
 * Ask the renderer to approve / reject a host key. Resolves `true`/`false`.
 * Times out (default 30s) -> treated as reject.
 */
function promptUser(
  host: string,
  port: number,
  fingerprint: string,
  reason: 'new' | 'changed',
  timeoutMs: number,
  deps: SshServiceDeps
): Promise<boolean> {
  const promptId = randomUUID()
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      pendingPrompts.delete(promptId)
      resolve(false)
    }, timeoutMs)

    pendingPrompts.set(promptId, { resolve, timer })
    try {
      deps.promptHostKey({ promptId, host, port, fingerprint, reason })
    } catch {
      // broadcast failure must not hang the attempt forever
      pendingPrompts.delete(promptId)
      clearTimeout(timer)
      resolve(false)
    }
  })
}

/**
 * Route a renderer host-key decision to the matching pending prompt.
 * Wired by the main process: ipcMain.on(Ipc.HOSTKEY_RESPOND, (…, promptId, action)).
 */
export function resolveHostKey(promptId: string, action: 'accept' | 'reject'): void {
  const pending = pendingPrompts.get(promptId)
  if (!pending) {
    console.error(`[ssh] resolveHostKey: no pending prompt ${promptId}`)
    return
  }
  clearTimeout(pending.timer)
  pendingPrompts.delete(promptId)
  pending.resolve(action === 'accept')
}

/** Read a private key file; surfaces a descriptive error on failure. */
function readKeyFile(keyPath: string): string {
  try {
    return readFileSync(keyPath, 'utf8')
  } catch (err) {
    throw new Error(`无法读取私钥文件 ${keyPath}: ${(err as Error).message}`)
  }
}