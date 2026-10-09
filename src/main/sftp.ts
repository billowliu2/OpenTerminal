import { dialog } from 'electron'
import type { Client, SFTPWrapper } from 'ssh2'
import { randomUUID } from 'crypto'
import { createWriteStream, promises as fsp } from 'fs'
import { basename } from 'path'
import { Ipc } from '../shared/ipc'
import { t } from '../shared/i18n'
import type { SftpEntry, TransferProgressEvent } from '../shared/sftp'
import {
  grantPickedDirectory,
  grantPickedFiles,
  grantedPaths,
  type LocalPathPolicy
} from './localPathGrants'

/**
 * Local-path admission for this module's transfers. Defaults to the real grant
 * registry — a caller that forgets to inject one is still enforced — and is
 * only swapped by the offline test harnesses, which have no dialog to grant
 * from. Never fed from renderer input.
 */
let pathPolicy: LocalPathPolicy = grantedPaths

export function setLocalPathPolicy(policy: LocalPathPolicy): void {
  pathPolicy = policy
}

/** ssh2 Client lookup injected by pty.ts (kind === 'ssh' sessions only). */
let clientProvider: ((id: string) => Client | undefined) | undefined

export function registerSftpClientProvider(provider: (id: string) => Client | undefined): void {
  clientProvider = provider
}

function p<T>(fn: (cb: (err: Error | null, res: T) => void) => void): Promise<T> {
  return bounded(rawP(fn), timeouts.op)
}

/** For ssh2 calls whose callback only yields an error. */
function pVoid(fn: (cb: (err: Error | null) => void) => void): Promise<void> {
  return bounded(rawVoid(fn), timeouts.op)
}

/**
 * Transfer-chunk variants: a 256KB read/write on a slow link is legitimately
 * seconds, so these run on the wider `transfer` budget instead of the metadata
 * one. Same class of failure, different tolerance.
 */
function pTransfer<T>(fn: (cb: (err: Error | null, res: T) => void) => void): Promise<T> {
  return bounded(rawP(fn), timeouts.transfer)
}

function pVoidTransfer(fn: (cb: (err: Error | null) => void) => void): Promise<void> {
  return bounded(rawVoid(fn), timeouts.transfer)
}

/**
 * Operation budgets.
 *
 * Two classes, because one number cannot serve both: metadata round trips are
 * milliseconds on any working link, while a 256KB transfer chunk on a slow link
 * is legitimately seconds (and the upload path additionally waits on a peer
 * that ACKs lazily — see the transfer section). The metadata budget is the
 * "channel is dead" detector; the transfer budget is a backstop for the same
 * failure at chunk granularity, set wide enough that it cannot fire on a merely
 * slow transfer.
 */
const timeouts = { op: 30_000, transfer: 60_000, open: 10_000 }

/**
 * Test seam: shrink the budgets so the offline harness does not have to wait
 * them out. Mirrors setLocalPathPolicy — injected, never read from renderer
 * input.
 */
export function setSftpTimeouts(patch: { op?: number; transfer?: number; open?: number }): void {
  if (patch.op !== undefined) timeouts.op = patch.op
  if (patch.transfer !== undefined) timeouts.transfer = patch.transfer
  if (patch.open !== undefined) timeouts.open = patch.open
}

/** Unbounded primitive behind `p` / `pVoid`. */
function rawP<T>(fn: (cb: (err: Error | null, res: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    fn((err, res) => (err ? reject(err) : resolve(res)))
  })
}

function rawVoid(fn: (cb: (err: Error | null) => void) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    fn(err => (err ? reject(err) : resolve()))
  })
}

/**
 * Reject `promise` once `ms` elapses. ssh2's SFTP callbacks are raw socket
 * completions: a channel that is half-dead (peer gone, no FIN ever delivered,
 * the case mobile / NAT'd links produce) accepts the request and then never
 * calls back — the operation, and the UI spinner behind it, used to wait
 * forever. The losing side of the race is left pending on purpose: it is only
 * dropped, never cancelled, so a late reply cannot resurrect the operation.
 */
function bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
  // The race may already have been decided by the time this one rejects; an
  // unhandled rejection would take the whole process down.
  promise.catch(() => undefined)
  let timer: NodeJS.Timeout | undefined
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new SftpTimeoutError(t('main.sftp.opTimeout', { seconds: Math.round(ms / 1000) })))
    }, ms)
  })
  return Promise.race([promise, expiry]).finally(() => {
    if (timer) clearTimeout(timer)
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
 * One SFTP channel PER SESSION, cached for the session's whole lifetime. Strict
 * sshd builds (MaxSessions 2-3, e.g. hardened cloud images) refuse extra
 * channels and drop the whole connection when every operation opens its own
 * subsystem. Only the session ending (pty.ts) or the channel itself erroring
 * drops it: a finished transfer must NOT close it, or the next transfer pays
 * for another subsystem.
 */
const sftpCache = new Map<string, SFTPWrapper>()

/**
 * Our own "session is gone" error. `isTransportError` classifies on the class,
 * not on the message text: the message is translated, the classifier must not
 * depend on the active locale.
 */
class SessionGoneError extends Error {}

/**
 * Our own "the client stopped answering" error: an SFTP subsystem open that
 * outlived its budget. Transport-classified, so withSftp evicts the possibly
 * half-dead channel and retries once on a fresh one.
 */
class SftpTimeoutError extends Error {}

/**
 * Our own "operation failed for a non-transport reason" error (server-side
 * failure summary, user cancellation). isTransportError rejects these outright:
 * their messages are translated and can embed remote paths/output, so text
 * matching would make the retry decision locale- and filename-dependent.
 */
class OperationError extends Error {}

async function sftpOf(sessionId: string): Promise<SFTPWrapper> {
  const cached = sftpCache.get(sessionId)
  if (cached) return cached
  const client = clientProvider?.(sessionId)
  if (!client) {
    console.error(`[sftp-debug] provider=${typeof clientProvider} sessionId=${sessionId} cacheSize=${sftpCache.size}`)
    throw new SessionGoneError(t('main.sftp.sessionGone'))
  }
  const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
    // A half-dead client can accept the subsystem request and then never call
    // back; bound the wait (like execQuiet does) so withSftp can evict and retry.
    const timer = setTimeout(
      () => reject(new SftpTimeoutError(t('main.sftp.openTimeout'))),
      timeouts.open
    )
    try {
      client.sftp((err, sftp_) => {
        clearTimeout(timer)
        if (err != null) reject(err)
        else resolve(sftp_)
      })
    } catch (err) {
      // ssh2 throws synchronously when the socket is already gone
      clearTimeout(timer)
      reject(err)
    }
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
 *
 * Classification is class-based for our own errors (SessionGoneError and
 * SftpTimeoutError are transport-level, OperationError is not) and matches only
 * the ssh2 library's own message strings for the rest: ssh2 is English-only and
 * never translated, so the decision cannot drift with the UI locale (our
 * translated messages arrive as OperationError and are rejected before any text
 * is inspected).
 */
function isTransportError(err: unknown): boolean {
  if (err instanceof SessionGoneError) return true
  if (err instanceof SftpTimeoutError) return true
  if (err instanceof OperationError) return false
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

/** readdir, both shapes ssh2 can yield (plain names or `{filename}` objects). */
function readdirDetailed(sftp: SFTPWrapper, dir: string): Promise<Array<{ name: string; longname?: string }>> {
  return p<Array<string | { filename: string; longname?: string }>>(cb => sftp.readdir(dir, cb)).then(raw =>
    raw.map(n => (typeof n === 'string' ? { name: n } : { name: n.filename, longname: n.longname }))
  )
}

function readdir(sftp: SFTPWrapper, dir: string): Promise<string[]> {
  return readdirDetailed(sftp, dir).then(list => list.map(e => e.name))
}

/**
 * Owner/group names off an OpenSSH longname, e.g.
 * `-rw-r--r--    1 eveuser  eveuser      231 Apr  1  2020 .bashrc`.
 * The mode string is required before we trust the field positions — some
 * servers put a different listing format in `longname` and the columns then
 * mean nothing. Best effort: any surprise yields `{}`, never a throw.
 */
function parseLongnameOwner(longname: string | undefined): { owner?: string; group?: string } {
  if (!longname) return {}
  const fields = longname.trim().split(/\s+/)
  if (fields.length < 4) return {}
  if (!/^[bcdlps-][rwxstST-]{9}$/.test(fields[0])) return {}
  return { owner: fields[2], group: fields[3] }
}

export function listRemote(sessionId: string, dir: string): Promise<SftpEntry[]> {
  return withSftp(sessionId, async sftp => {
    const names = await readdirDetailed(sftp, dir)
    const entries: SftpEntry[] = []
    const queue = [...names]
    const base = dir.replace(/\/+$/, '') || '/'
    const workers = Array.from({ length: Math.min(8, Math.max(queue.length, 1)) }, async () => {
      for (;;) {
        const item = queue.shift()
        if (item === undefined) return
        const { name, longname } = item
        const path = `${base}/${name}`
        try {
          const st = await lstat(sftp, path)
          entries.push({
            name, path, isDir: st.isDirectory(), size: st.size, mtime: st.mtime * 1000,
            uid: st.uid, gid: st.gid, mode: formatMode(st.mode), ...parseLongnameOwner(longname)
          })
        } catch {
          // no longname data here — the namespace listing is all we have
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

/**
 * "The file is already gone" — the one server-side failure a delete may treat
 * as success. ssh2 reports the SFTP status both ways: `code` carries the numeric
 * status (2 = SSH_FX_NO_SUCH_FILE) and `message` the library's own English text,
 * so both are checked (builds fill one or the other). Our own translated errors
 * never reach this check — they arrive as OperationError, which the caller
 * passes through untouched.
 */
function isNoSuchFile(err: unknown): boolean {
  if ((err as { code?: unknown } | undefined)?.code === 2) return true
  return /no such file/i.test((err as Error | undefined)?.message ?? '')
}

/**
 * unlink/rmdir where "already gone" counts as success.
 *
 * Deleting is not idempotent by nature: the entry may have been removed by
 * someone else between the listing and the click, or the same delete may be run
 * again after an earlier pass already removed it. Reporting a path that is
 * verifiably gone as "delete failed" is a fake error — the end state the user
 * asked for already holds.
 */
async function unlinkIfPresent(sftp: SFTPWrapper, path: string): Promise<void> {
  try {
    await pVoid(cb => sftp.unlink(path, cb))
  } catch (err) {
    if (!isNoSuchFile(err)) throw err
  }
}

async function rmdirIfPresent(sftp: SFTPWrapper, path: string): Promise<void> {
  try {
    await pVoid(cb => sftp.rmdir(path, cb))
  } catch (err) {
    if (!isNoSuchFile(err)) throw err
  }
}

async function deleteRecursive(sftp: SFTPWrapper, path: string, isDir: boolean): Promise<void> {
  if (!isDir) {
    await unlinkIfPresent(sftp, path)
    return
  }
  let names: string[]
  try {
    names = await readdir(sftp, path)
  } catch (err) {
    // The directory is gone (removed by someone else, or by an earlier pass of
    // this same delete): everything inside went with it, so the intent holds.
    if (isNoSuchFile(err)) return
    throw err
  }
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
  await rmdirIfPresent(sftp, path)
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
          // stat failed — fall through to unlink, which tolerates "already gone"
        }
        await deleteRecursive(sftp, path, isDir)
      } catch (err) {
        failures.push(`${path}: ${(err as Error).message}`)
      }
    }
    if (failures.length > 0) {
      throw new OperationError(t('main.sftp.deleteFailed', { detail: failures.join('; ') }))
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

/**
 * Path checks for the local side of a transfer.
 *
 * Threat model: `localPaths` and `localDir` arrive from the renderer, which is
 * untrusted — without a check the main process would read or write any path the
 * user can reach (a compromised renderer, a hand-crafted IPC message, or a
 * future caller that forgets the dialog). Only paths the user granted through a
 * native dialog are accepted; see localPathGrants.ts for what a grant is and
 * why it is realpath-based.
 *
 * Both helpers throw, so the invoke rejects right away and the renderer
 * surfaces the reason instead of starting a transfer that fails later. The
 * checks run *before* the sftp channel is opened, so a refused request never
 * costs a subsystem channel. Each returns the *resolved* path to open: the
 * caller must use that, not the renderer's spelling, or it would re-traverse
 * the very symlink the check followed.
 */
function requireUploadSources(localPaths: unknown): { source: string; name: string }[] {
  if (!Array.isArray(localPaths) || localPaths.length === 0) {
    throw new Error(t('main.sftp.localNotAllowed', { path: '' }))
  }
  return localPaths.map(local => {
    // readSource also insists on a real regular file: a directory or a device
    // node must never reach the upload's file handle.
    const source = pathPolicy.readSource(local)
    if (source === null) {
      throw new Error(t('main.sftp.localNotAllowed', { path: String(local) }))
    }
    // The remote name stays the one derived from the path the USER saw in the
    // dialog, not from the resolved target: FilePanel computes its overwrite
    // confirmation from the same spelling, and a name that differed from the
    // one the user approved would let an upload overwrite a file it never
    // warned about. Only the path that gets READ is the resolved one.
    return { source, name: basename(String(local)) }
  })
}

/**
 * Where each remote file lands locally. The directory must be one the user
 * granted, and the name is the remote file's basename — checked as a plain leaf
 * with any symlink already sitting at that name resolved (see
 * localPathGrants.ts).
 */
function requireDownloadTargets(
  remotePaths: unknown,
  localDir: unknown
): { remote: string; name: string; target: string }[] {
  if (!Array.isArray(remotePaths) || remotePaths.length === 0) {
    throw new Error(t('main.sftp.localNotAllowed', { path: String(localDir) }))
  }
  return remotePaths.map(remote => {
    const path = String(remote)
    const name = basename(path)
    const target = pathPolicy.writeTarget(localDir, name)
    if (target === null) {
      throw new Error(t('main.sftp.localNotAllowed', { path: String(localDir) }))
    }
    return { remote: path, name, target }
  })
}

export function uploadRemote(
  sessionId: string,
  localPaths: string[],
  remoteDir: string,
  broadcast: Broadcast
): Promise<string> {
  const sources = requireUploadSources(localPaths)
  return withSftp(sessionId, async sftp => {
    const id = randomUUID()
    const transfer: ActiveTransfer = { kind: 'upload', cancelled: false }
    activeTransfers.set(id, transfer)
    const emit = (e: TransferProgressEvent): void => broadcast(Ipc.TRANSFER_PROGRESS, e)

    void (async () => {
      try {
        for (const { source: local, name } of sources) {
          if (transfer.cancelled) break
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
                if (transfer.cancelled) throw new OperationError(t('main.sftp.cancelled'))
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
                const pr = pVoidTransfer(cb => sftp.write(handle, buf, 0, bytesRead, offset, cb))
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
              // The stall guard owns this wait (10s), so the close itself stays
              // unbounded-by-`bounded` — otherwise a timeout landing after the
              // race is decided would reject with nothing listening.
              rawVoid(cb => sftp.close(handle, cb)),
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
        // The cached channel belongs to the session, not to this transfer: only
        // the session ending or the channel erroring drops it (see the cache note
        // at the top of the file).
        activeTransfers.delete(id)
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
  const targets = requireDownloadTargets(remotePaths, localDir)
  return withSftp(sessionId, async sftp => {
    const id = randomUUID()
    const transfer: ActiveTransfer = { kind: 'download', cancelled: false }
    activeTransfers.set(id, transfer)
    const emit = (e: TransferProgressEvent): void => broadcast(Ipc.TRANSFER_PROGRESS, e)

    void (async () => {
      try {
        for (const { remote, name, target: local } of targets) {
          if (transfer.cancelled) break
          const { size } = await p<{ size: number }>(cb => sftp.stat(remote, cb))
          const handle = await p<Buffer>(cb => sftp.open(remote, 'r', cb))
          try {
            const localHandle = await fsp.open(local, 'w')
            try {
              let pos = 0
              let lastEmit = 0
              const buf = Buffer.alloc(CHUNK)
              for (;;) {
                if (transfer.cancelled) throw new OperationError(t('main.sftp.cancelled'))
                const { bytesRead } = await pTransfer<{ bytesRead: number; buffer: Buffer }>(cb =>
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
        // The cached channel belongs to the session, not to this transfer: only
        // the session ending or the channel erroring drops it (see the cache note
        // at the top of the file).
        activeTransfers.delete(id)
      }
    })()

    return id
  })
}

/**
 * Native file dialogs parented to the focused window.
 *
 * These two are the ONLY grant source (see localPathGrants.ts): whatever the
 * user picks here becomes usable by the transfer paths, and nothing else does.
 * A cancelled dialog grants nothing — the empty result must not be read as
 * "no restriction". Both return `filePaths` verbatim so the renderer's own
 * display logic is unchanged.
 */
export async function pickFiles(): Promise<string[]> {
  const r = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] })
  grantPickedFiles(r.filePaths)
  return r.filePaths
}

export async function pickDirectory(): Promise<string> {
  const r = await dialog.showOpenDialog({ properties: ['openDirectory'] })
  const dir = r.filePaths[0] ?? ''
  if (dir !== '') grantPickedDirectory(dir)
  return dir
}
