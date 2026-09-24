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
import { t } from '../shared/i18n'
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
  /**
   * Exit code reported for the session: the channel's 'exit' event when the
   * remote sends one, 1 when the client errors out mid-session, else 0.
   */
  exitCode: number
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
  let sessionHandle: SshSessionHandle | undefined
  let resolvePromise!: (handle: SshSessionHandle) => void
  let rejectPromise!: (err: Error) => void

  const armConnectTimer = (): void => {
    if (connectTimer) clearTimeout(connectTimer)
    connectTimer = setTimeout(() => {
      fail(new Error(t('main.ssh.connectTimeout', { host: conn.host, port: conn.port })))
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
    let status: HostKeyCheckResult['status']
    try {
      fingerprint = fingerprintOf(hostKey)
      status = deps.knownHosts.check(conn.host, conn.port, hostKey).status
    } catch (err) {
      console.error(`[ssh] knownHosts.check threw: ${(err as Error).message}`)
      fingerprint = fingerprintOf(hostKey)
      // A throwing store is as untrustworthy as an unreadable one: falling back
      // to 'new' would let the subsequent accept() rewrite the whole store.
      status = 'unreadable'
    }

    if (status === 'match') {
      verify(true)
      return
    }

    if (status === 'unreadable') {
      // known_hosts exists but cannot be read (corrupt JSON, access error...).
      // Accepting would persist the new key into a table we failed to load and
      // destroy every pinned fingerprint, so fail closed instead of prompting:
      // no accept offer, the user repairs or deletes the file and retries.
      verifierErr = t('main.ssh.knownHostsUnreadable')
      console.error(`[ssh] ${verifierErr}`)
      verify(false)
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
            verifierErr = t('main.ssh.saveFingerprintFailed', { detail: (err as Error).message })
            verify(false)
            return
          }
          verify(true)
        } else {
          verifierErr = t('main.ssh.hostKeyRejected')
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
        fail(new Error(t('main.ssh.connectFailed', { host: conn.host, port: conn.port, detail: message })))
        return
      }
      // Session already established: surface as a session exit and clean up.
      // Record the failure code on the handle so the stream's later 'close'
      // (pty.ts teardown) reports the same exit code instead of a bogus 0 —
      // the broadcast itself must come only from pty.ts's idempotent teardown;
      // emitting it here as well would fire PTY_EXIT twice (destroy() closes
      // the stream, and the stream 'close' handler broadcasts on its own).
      if (sessionHandle) sessionHandle.exitCode = 1
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
            fail(
              new Error(
                t('main.ssh.shellOpenFailed', { host: conn.host, port: conn.port, detail: err.message })
              )
            )
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
          sessionHandle = { id: sessionId, client: handshake, stream: shell, exitCode: 0 }
          resolvePromise(sessionHandle)
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

    // Password auth. A stored password is offered only when the bookmark is
    // configured for password auth: connectionsStore keeps password_enc when a
    // bookmark is switched to key/agent auth, and silently falling back to it
    // would authenticate a weaker method than the user chose. The same gate
    // applies to a typed connect-time password (secretOverride): it belongs to
    // the password flow and must never upgrade a key/agent bookmark into
    // password auth (a stale ask flag used to route one here via ConnectFlow).
    const password =
      conn.auth === 'password'
        ? (secretOverride?.password ?? deps.connections.getSecret(conn, 'password'))
        : undefined
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
        // A typed connect-time passphrase (secretOverride) is honoured only
        // inside this private-key branch — the gate above keeps the password
        // override out of key auth and this branch keeps the passphrase out of
        // password auth.
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
      fail(
        new Error(
          t('main.ssh.initFailed', { host: conn.host, port: conn.port, detail: (err as Error).message })
        )
      )
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
    throw new Error(t('main.ssh.readKeyFailed', { path: keyPath, detail: (err as Error).message }))
  }
}