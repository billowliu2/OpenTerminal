import { dialog } from 'electron'
import type { Client, SFTPWrapper } from 'ssh2'
import { randomUUID } from 'crypto'
import { createWriteStream, promises as fsp } from 'fs'
import { basename, join } from 'path'
import { Ipc } from '../shared/ipc'
import { t } from '../shared/i18n'
import type { SftpEntry, TransferProgressEvent } from '../shared/sftp'

/** ssh2 Client lookup injected by pty.ts (kind === 'ssh' sessions only). */
let clientProvider: ((id: string) => Client | undefined) | undefined

export function registerSftpClientProvider(provider: (id: string) => Client | undefined): void {
  clientProvider = provider
}

function p<T>(fn: (cb: (err: Error | null, res: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    fn((err, res) => (err ? reject(err) : resolve(res)))
  })
}

/** For ssh2 calls whose callback only yields an error. */
function pVoid(fn: (cb: (err: Error | null) => void) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    fn(err => (err ? reject(err) : resolve()))
  })
}

type StatLike = { isDirectory(): boolean; size: number; mtime: number; mode: number; uid: number; gid: number }

function lstat(sftp: SFTPWrapper, path: string): Promise<StatLike> {
  return p(cb => sftp.lstat(path, cb))
}

/** "drwxr-xr-x"-style string from a numeric POSIX mode (best effort). */
export function formatMode(mode: number): string {
  const kind = (mode & 0o170000) === 0o040000 ? 'd' : '-'
  const groups: [number, string][] = [
    [0o400, 'r'], [0o200, 'w'], [0o100, 'x'],
    [0o040, 'r'], [0o020, 'w'], [0o010, 'x'],
    [0o004, 'r'], [0o002, 'w'], [0o001, 'x']
  ]
  const perm = groups.map(([bit, ch]) => ((mode & bit) !== 0 ? ch : '-'))
  // Special bits share the x columns: setuid/setgid → s/S, sticky → t/T
  // (uppercase when the corresponding execute bit is clear). The renderer's
  // permission editor round-trips these, so report them instead of dropping.
  if ((mode & 0o4000) !== 0) perm[2] = perm[2] === 'x' ? 's' : 'S'
  if ((mode & 0o2000) !== 0) perm[5] = perm[5] === 'x' ? 's' : 'S'
  if ((mode & 0o1000) !== 0) perm[8] = perm[8] === 'x' ? 't' : 'T'
  return kind + perm.join('')
}

/**
 * One SFTP channel PER SESSION, cached. Strict sshd builds (MaxSessions 2-3,
 * e.g. hardened cloud images) refuse extra channels and drop the whole
 * connection when every operation opens its own subsystem.
 */
const sftpCache = new Map<string, SFTPWrapper>()

/**
 * Our own "session is gone" error. `isTransportError` classifies on the class,
 * not on the message text: the message is translated, the classifier must not
 * depend on the active locale.
 */
class SessionGoneError extends Error {}

async function sftpOf(sessionId: string): Promise<SFTPWrapper> {
  const cached = sftpCache.get(sessionId)
  if (cached) return cached
  const client = clientProvider?.(sessionId)
  if (!client) {
    console.error(`[sftp-debug] provider=${typeof clientProvider} sessionId=${sessionId} cacheSize=${sftpCache.size}`)
    throw new SessionGoneError(t('main.sftp.sessionGone'))
  }
  const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
    client.sftp((err, sftp_) => (err != null ? reject(err) : resolve(sftp_)))
  })
  // ssh2.d.ts declares only the used surface; the wrapper is an EventEmitter
  ;(sftp as SFTPWrapper & { on(event: 'error', cb: (err: Error) => void): void }).on('error', (err: Error) => {
    console.error(`[sftp] channel error sessionId=${sessionId}: ${err.message}`)
    if (sftpCache.get(sessionId) === sftp) evictSftp(sessionId)
  })
  sftpCache.set(sessionId, sftp)
  return sftp
}

function evictSftp(sessionId: string): void {
  const sftp = sftpCache.get(sessionId)
  sftpCache.delete(sessionId)
  try {
    sftp?.end?.()
  } catch {
    // best effort — the channel may already be dead
  }
}

/**
 * Server-side SFTP failures (Failure / permission denied / no such file /
 * already exists) mean the CHANNEL IS ALIVE — retrying them would just open
 * another subsystem channel, which strict sshd (MaxSessions 2) punishes by
 * dropping the whole connection. Only transport-level death retries.
 */
function isTransportError(err: unknown): boolean {
  if (err instanceof SessionGoneError) return true
  const msg = (err as Error | undefined)?.message ?? ''
  return /not connected|ECONNRESET|EPIPE|timed out|disconnected|channel|read past end|no response/i.test(msg)
}

/** Run `fn` with the session's cached sftp; a dead cached channel is evicted and retried once. */
async function withSftp<T>(sessionId: string, fn: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
  try {
    return await fn(await sftpOf(sessionId))
  } catch (err) {
    if (!isTransportError(err)) throw err
    evictSftp(sessionId)
    return fn(await sftpOf(sessionId))
  }
}

/** Drop the cached channel when the session is gone. */
export function closeSftp(sessionId: string): void {
  evictSftp(sessionId)
}

const FAKE_FS = new Set(['tmpfs', 'overlay', 'udev', 'devtmpfs', 'none', 'squashfs', 'shm'])

export function listRemote(sessionId: string, dir: string): Promise<SftpEntry[]> {
  return withSftp(sessionId, async sftp => {
    const raw = await new Promise<Array<string | { filename: string }>>((resolve, reject) => {
      sftp.readdir(dir, (err, names) => (err ? reject(err) : resolve(names)))
    })
    // ssh2 readdir yields plain strings OR {filename} objects depending on version/options
    const names = raw.map(n => (typeof n === 'string' ? n : n.filename))
    const entries: SftpEntry[] = []
    const queue = [...names]
    const base = dir.replace(/\/+$/, '') || '/'
    const workers = Array.from({ length: Math.min(8, Math.max(queue.length, 1)) }, async () => {
      for (;;) {
        const name = queue.shift()
        if (name === undefined) return
        const path = `${base}/${name}`
        try {
          const st = await lstat(sftp, path)
          entries.push({
            name, path, isDir: st.isDirectory(), size: st.size, mtime: st.mtime * 1000,
            uid: st.uid, gid: st.gid, mode: formatMode(st.mode)
          })
        } catch {
          entries.push({ name, path, isDir: false, size: 0, mtime: 0 })
        }
      }
    })
    await Promise.all(workers)
    entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    return entries
  })
}

export function mkdirRemote(sessionId: string, dir: string, name: string): Promise<void> {
  return withSftp(sessionId, sftp => {
    const base = dir.replace(/\/+$/, '') || '/'
    return pVoid(cb => sftp.mkdir(`${base}/${name}`, cb))
  })
}

export function renameRemote(sessionId: string, from: string, to: string): Promise<void> {
  return withSftp(sessionId, sftp => pVoid(cb => sftp.rename(from, to, cb)))
}

async function deleteRecursive(sftp: SFTPWrapper, path: string, isDir: boolean): Promise<void> {
  if (!isDir) {
    await pVoid(cb => sftp.unlink(path, cb))
    return
  }
  const raw = await new Promise<Array<string | { filename: string }>>((resolve, reject) => {
    sftp.readdir(path, (err, names) => (err ? reject(err) : resolve(names)))
  })
  const names = raw.map(n => (typeof n === 'string' ? n : n.filename))
  const base = path.replace(/\/+$/, '') || '/'
  for (const name of names) {
    const child = `${base}/${name}`
    let childIsDir = false
    try {
      childIsDir = (await lstat(sftp, child)).isDirectory()
    } catch {
      // unreadable child — fall through to unlink
    }
    await deleteRecursive(sftp, child, childIsDir)
  }
  await pVoid(cb => sftp.rmdir(path, cb))
}

export function deleteRemote(sessionId: string, paths: string[]): Promise<void> {
  return withSftp(sessionId, async sftp => {
    const failures: string[] = []
    for (const path of paths) {
      try {
        let isDir = false
        try {
          isDir = (await lstat(sftp, path)).isDirectory()
        } catch {
          // stat failed — fall through to unlink
        }
        await deleteRecursive(sftp, path, isDir)
      } catch (err) {
        failures.push(`${path}: ${(err as Error).message}`)
      }
    }
    if (failures.length > 0) {
      throw new Error(t('main.sftp.deleteFailed', { detail: failures.join('; ') }))
    }
  })
}

/** mode = octal string, e.g. "755" or "0644". */
/**
 * chmod/chown run over an exec channel: the JD test server's sftp subsystem
 * accepts SETSTAT but silently ignores it, while shell chmod/chown work.
 */
/**
 * POSIX single-quote escaping. `JSON.stringify` only escapes `"`, so a remote
 * file name containing `$`, a backtick or a quote would still be expanded by the
 * far-side shell — that is remote command execution triggered by a file name.
 */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function chmodRemote(sessionId: string, path: string, mode: string): Promise<void> {
  if (!/^[0-7]{1,4}$/.test(mode)) throw new Error(t('main.sftp.invalidMode', { mode }))
  return execQuiet(sessionId, `chmod ${mode} ${shQuote(path)}`)
}

export function chownRemote(sessionId: string, path: string, uid: number, gid: number): Promise<void> {
  if (!Number.isInteger(uid) || !Number.isInteger(gid)) {
    throw new Error(t('main.sftp.invalidUidGid'))
  }
  return execQuiet(sessionId, `chown ${uid}:${gid} ${shQuote(path)}`)
}

/** Run a command on the session's shell channel and wait for it to finish. */
function execQuiet(sessionId: string, cmd: string): Promise<void> {
  const client = clientProvider?.(sessionId)
  if (!client) throw new SessionGoneError(t('main.sftp.sessionGone'))
  return new Promise((resolve, reject) => {
    client.exec(cmd, (err, stream) => {
      if (err) {
        reject(err)
        return
      }
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => {
        stream.close()
        reject(new Error(t('main.sftp.commandTimeout')))
      }, 10_000)
      stream.on('data', (d: Buffer) => {
        stdout += d.toString('utf8')
      })
      stream.stderr?.on('data', (d: Buffer) => {
        stderr += d.toString('utf8')
      })
      stream.on('error', (e: Error) => {
        clearTimeout(timer)
        reject(e)
      })
      stream.on('close', (code: number) => {
        clearTimeout(timer)
        if (code) reject(new Error(stderr || stdout || t('main.sftp.commandExitCode', { code })))
        else resolve()
      })
    })
  })
}

// ---- transfers ----------------------------------------------------------------
//
// Low-level positional read/write over an SFTP file handle. The JD cloud sshd
// ACKs write requests LAZILY — awaiting each ack deadlocks (the ack only
// flushes when more requests arrive) — so writes keep a bounded pipeline in
// flight and the remote handle is closed with a stall guard at the end.
// Reads respond normally, so downloads stay sequential.

interface ActiveTransfer {
  kind: 'upload' | 'download'
  cancelled: boolean
}

const activeTransfers = new Map<string, ActiveTransfer>()

export function cancelTransfer(transferId: string): void {
  const t = activeTransfers.get(transferId)
  if (t) t.cancelled = true
}

type Broadcast = (channel: string, payload: unknown) => void
const CHUNK = 256 * 1024
const UPLOAD_WINDOW = 64

export function uploadRemote(
  sessionId: string,
  localPaths: string[],
  remoteDir: string,
  broadcast: Broadcast
): Promise<string> {
  return withSftp(sessionId, async sftp => {
    const id = randomUUID()
    const transfer: ActiveTransfer = { kind: 'upload', cancelled: false }
    activeTransfers.set(id, transfer)
    const emit = (e: TransferProgressEvent): void => broadcast(Ipc.TRANSFER_PROGRESS, e)

    void (async () => {
      try {
        for (const local of localPaths) {
          if (transfer.cancelled) break
          const name = basename(local)
          const size = (await fsp.stat(local)).size
          const remote = `${remoteDir.replace(/\/+$/, '')}/${name}`
          const handle = await p<Buffer>(cb => sftp.open(remote, 'w', cb))
          const inflight = new Set<Promise<void>>()
          let firstError: Error | undefined
          try {
            const localHandle = await fsp.open(local, 'r')
            try {
              let pos = 0
              let lastEmit = 0
              for (;;) {
                if (transfer.cancelled) throw new Error(t('main.sftp.cancelled'))
                if (firstError) throw firstError
                while (inflight.size >= UPLOAD_WINDOW) {
                  await Promise.race(inflight)
                  if (firstError) throw firstError
                }
                // per-iteration buffer: pipelined writes outlive the loop, and
                // ssh2 re-reads the overflow tail after the ACK arrives
                const buf = Buffer.allocUnsafe(CHUNK)
                const { bytesRead } = await localHandle.read(buf, 0, CHUNK, pos)
                if (bytesRead === 0) break
                const offset = pos
                pos += bytesRead
                const now = Date.now()
                if (now - lastEmit > 150 || pos === size) {
                  lastEmit = now
                  emit({ transferId: id, kind: 'upload', state: 'running', file: name, bytes: pos, totalBytes: size })
                }
                const pr = pVoid(cb => sftp.write(handle, buf, 0, bytesRead, offset, cb))
                inflight.add(
                  pr.catch((err: Error) => {
                    firstError = firstError ?? err
                  })
                )
              }
              // NOTE: do NOT await the write acks before close — this server
              // acks lazily; close flushes and commits everything server-side.
            } finally {
              await localHandle.close()
            }
            await Promise.race([
              pVoid(cb => sftp.close(handle, cb)),
              new Promise<void>((r) => setTimeout(r, 10_000))
            ])
            await Promise.allSettled(inflight)
            if (firstError) throw firstError
          } catch (err) {
            await pVoid(cb => sftp.unlink(remote, cb)).catch(() => undefined)
            throw err
          }
          if (transfer.cancelled) {
            await pVoid(cb => sftp.unlink(remote, cb)).catch(() => undefined)
            emit({ transferId: id, kind: 'upload', state: 'cancelled', file: name, bytes: 0, totalBytes: size })
            return
          }
        }
        emit({ transferId: id, kind: 'upload', state: 'done', file: '', bytes: 0, totalBytes: 0 })
      } catch (err) {
        emit({
          transferId: id, kind: 'upload',
          state: transfer.cancelled ? 'cancelled' : 'error',
          file: '', bytes: 0, totalBytes: 0,
          error: (err as Error).message
        })
      } finally {
        activeTransfers.delete(id)
        closeSftp(sessionId)
      }
    })()

    return id
  })
}

export function downloadRemote(
  sessionId: string,
  remotePaths: string[],
  localDir: string,
  broadcast: Broadcast
): Promise<string> {
  return withSftp(sessionId, async sftp => {
    const id = randomUUID()
    const transfer: ActiveTransfer = { kind: 'download', cancelled: false }
    activeTransfers.set(id, transfer)
    const emit = (e: TransferProgressEvent): void => broadcast(Ipc.TRANSFER_PROGRESS, e)

    void (async () => {
      try {
        for (const remote of remotePaths) {
          if (transfer.cancelled) break
          const name = basename(remote)
          const { size } = await p<{ size: number }>(cb => sftp.stat(remote, cb))
          const local = join(localDir, name)
          const handle = await p<Buffer>(cb => sftp.open(remote, 'r', cb))
          try {
            const localHandle = await fsp.open(local, 'w')
            try {
              let pos = 0
              let lastEmit = 0
              const buf = Buffer.alloc(CHUNK)
              for (;;) {
                if (transfer.cancelled) throw new Error(t('main.sftp.cancelled'))
                const { bytesRead } = await p<{ bytesRead: number; buffer: Buffer }>(cb =>
                  sftp.read(handle, buf, 0, CHUNK, pos, cb)
                )
                if (bytesRead === 0) break
                await localHandle.write(buf, 0, bytesRead, pos)
                pos += bytesRead
                const now = Date.now()
                if (now - lastEmit > 150 || pos === size) {
                  lastEmit = now
                  emit({ transferId: id, kind: 'download', state: 'running', file: name, bytes: pos, totalBytes: size })
                }
              }
            } finally {
              await localHandle.close()
            }
          } catch (err) {
            await fsp.rm(local, { force: true })
            throw err
          } finally {
            await pVoid(cb => sftp.close(handle, cb)).catch(() => undefined)
          }
          if (transfer.cancelled) {
            await fsp.rm(local, { force: true })
            emit({ transferId: id, kind: 'download', state: 'cancelled', file: name, bytes: 0, totalBytes: 0 })
            return
          }
        }
        emit({ transferId: id, kind: 'download', state: 'done', file: '', bytes: 0, totalBytes: 0 })
      } catch (err) {
        emit({
          transferId: id, kind: 'download',
          state: transfer.cancelled ? 'cancelled' : 'error',
          file: '', bytes: 0, totalBytes: 0,
          error: (err as Error).message
        })
      } finally {
        activeTransfers.delete(id)
        closeSftp(sessionId)
      }
    })()

    return id
  })
}

/** Native file dialogs parented to the focused window. */
export async function pickFiles(): Promise<string[]> {
  const r = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] })
  return r.filePaths
}

export async function pickDirectory(): Promise<string> {
  const r = await dialog.showOpenDialog({ properties: ['openDirectory'] })
  return r.filePaths[0] ?? ''
}
