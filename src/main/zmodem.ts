/**
 * ZMODEM engine (M6) - lives in the MAIN process and only ever runs over an SSH
 * session stream, using zmodem.js@0.1.10.
 *
 * LOCAL PTY SESSIONS ARE DELIBERATELY NOT SUPPORTED: node-pty / Windows ConPTY
 * only hand us UTF-8 strings and are lossy for arbitrary bytes, so a binary
 * ZMODEM stream would be corrupted (and there is no file dialog on the local
 * side anyway). The engine is therefore only ever attached to an ssh2 channel,
 * where we get raw Buffers.
 *
 * Design mirrors pty.ts's dependency-injection pattern: this module holds no
 * Electron import. pty.ts injects `broadcast`/`toTerminal`/`writeStream`, and
 * routes the ssh stream's 'data' through `feedZmodem`. While a transfer is
 * active we suppress the normal terminal data-plane (binary frames must never
 * reach the terminal), and pty.ts's writePty drops user keystrokes via
 * isZmodemActive.
 */
import { basename } from 'path'
import { createReadStream, createWriteStream } from 'fs'
import { stat } from 'fs/promises'
import type { Writable } from 'stream'
import * as Zmodem from 'zmodem.js'
import { Ipc } from '../shared/ipc'
import type { ZmodemDoneEvent, ZmodemResponse } from '../shared/ipc'
import type { TransferProgressEvent } from '../shared/sftp'
import { t } from '../shared/i18n'
import { grantedPaths, type LocalPathPolicy } from './localPathGrants'

/**
 * Local-path admission, same shape and same rationale as sftp.ts's: defaults to
 * the real grant registry so a caller that forgets to inject one is still
 * enforced, and the offline e2e harness swaps in a double because it has no
 * dialog to grant from. Never fed from renderer input.
 */
let pathPolicy: LocalPathPolicy = grantedPaths

export function setLocalPathPolicy(policy: LocalPathPolicy): void {
  pathPolicy = policy
}

/** How long to wait for the renderer to answer a ZMODEM_OFFER (ms). */
const OFFER_TIMEOUT_MS = 120_000
/** Abort a transfer that makes no byte progress for this long (ms). */
const STALL_TIMEOUT_MS = 90_000
/**
 * Progress broadcast floor (ms), same value as sftp.ts. A receive calls
 * on_input once per ZDATA subpacket (1-8KB), so an unthrottled emit is one
 * webContents.send per packet: ~10k-100k events for a 100MB file, and every
 * one of them copies the transfer Map in TransferPanel and re-renders it.
 */
const PROGRESS_THROTTLE_MS = 150

const ABORT_BUFFER = Buffer.from(Zmodem.ZMLIB.ABORT_SEQUENCE)

export interface ZmodemDeps {
  /** Emit a main->renderer broadcast (ZMODEM_OFFER / ZMODEM_DONE / TRANSFER_PROGRESS). */
  broadcast(channel: string, ...args: unknown[]): void
  /**
   * Forward NON-ZMODEM octets back through the normal terminal data path
   * (utf8 decode + replay + session log + PTY_DATA). pty.ts injects this and
   * owns the decoding (per-session StringDecoder — a multi-byte char may be
   * split across TCP chunks); the engine only calls it when no transfer is
   * active.
   */
  toTerminal(sessionId: string, data: Buffer): void
  /** Write bytes out to the ssh stream (zmodem frames + CAN abort sequence). */
  writeStream(sessionId: string, data: Buffer): void
}

interface Engine {
  id: string
  deps: ZmodemDeps
  sentry: Zmodem.Sentry
  detection: Zmodem.Detection | null
  session: Zmodem.SendSession | Zmodem.ReceiveSession | null
  /** True from header detection until the session ends / teardown. */
  active: boolean
  mode: 'send' | 'receive' | null
  dir: string | null
  /** True once the detection is confirmed and files start flowing. */
  confirmed: boolean
  transferId: string
  /** one progress terminal event at most */
  progressEmitted: boolean
  /** Timestamp of the last *running* progress broadcast (throttle window). */
  lastProgressAt: number
  /**
   * True while *we* are tearing the session down (abort). zmodem.js's abort()
   * fires 'session_end' synchronously, and that event must not be read as the
   * peer finishing cleanly — see makeSessionEnd().
   */
  ending: boolean
  doneEmitted: boolean
  offerTimer: NodeJS.Timeout | null
  stallTimer: NodeJS.Timeout | null
  receiveStream: Writable | null
  bytes: number
  totalBytes: number
}

const engines = new Map<string, Engine>()

function current(sessionId: string): Engine | undefined {
  return engines.get(sessionId)
}

function cancelTimers(engine: Engine): void {
  if (engine.offerTimer) clearTimeout(engine.offerTimer)
  if (engine.stallTimer) clearTimeout(engine.stallTimer)
  engine.offerTimer = null
  engine.stallTimer = null
}

function emitProgress(engine: Engine, patch: Partial<TransferProgressEvent>): void {
  const evt: TransferProgressEvent = {
    transferId: engine.transferId,
    kind: engine.mode === 'receive' ? 'zmodem-download' : 'zmodem-upload',
    state: 'running',
    file: '',
    bytes: engine.bytes,
    totalBytes: engine.totalBytes,
    ...patch
  }
  try {
    engine.deps.broadcast(Ipc.TRANSFER_PROGRESS, evt)
  } catch {
    // never crash the event loop
  }
}

/**
 * Progress broadcast with a 150ms floor (same rule as sftp.ts). `force` is for
 * events that must land no matter what — a file boundary or the final byte
 * count of a transfer — so the UI never stops on a stale number.
 */
function emitProgressThrottled(
  engine: Engine,
  patch: Partial<TransferProgressEvent>,
  force = false
): void {
  // Nothing may report progress once the transfer is over: a late `running`
  // event (a send loop or an accept() callback that outlives the session)
  // would flip the renderer's finished row back to "in progress" with no
  // terminal event left to close it.
  if (!engine.active) return
  const now = Date.now()
  if (!force && now - engine.lastProgressAt < PROGRESS_THROTTLE_MS) return
  engine.lastProgressAt = now
  emitProgress(engine, patch)
}

function emitDone(engine: Engine, ok: boolean, message?: string): void {
  if (engine.doneEmitted) return
  engine.doneEmitted = true
  const evt: ZmodemDoneEvent = { id: engine.id, ok, message }
  try {
    engine.deps.broadcast(Ipc.ZMODEM_DONE, evt)
  } catch {
    // never crash the event loop
  }
}

/**
 * End-of-session / cancel / error common path: stop suppressing the terminal
 * data plane, drop timers, release streams, and emit the terminal events once.
 */
function finalize(
  engine: Engine,
  ok: boolean,
  message?: string,
  failState: 'cancelled' | 'error' = 'error'
): void {
  engine.active = false
  // Everything below is us ending the session, not the peer: abort() fires
  // 'session_end' synchronously (see makeSessionEnd), and that must not be
  // mistaken for a clean finish.
  engine.ending = true
  cancelTimers(engine)
  const stream = engine.receiveStream
  engine.receiveStream = null
  // Clear the slot *before* end(): an errored/destroyed sink must not be ended
  // again (ERR_STREAM_DESTROYED), and the 'error' handler must no longer see
  // this stream as the current one.
  if (stream && !stream.destroyed && !stream.writableEnded) {
    try {
      stream.end()
    } catch {
      // already closed
    }
  }
  if (!ok && engine.session) {
    // Failure paths (stall watchdog, corrupt frame) must stop the peer too:
    // without an abort the remote rz/sz keeps transmitting frames that then
    // leak into the terminal and the session log.
    try {
      engine.session.abort()
    } catch {
      // session already ended
    }
  }
  engine.session = null
  engine.detection = null

  if (!engine.progressEmitted) {
    emitProgress(engine, { state: ok ? 'done' : failState, file: message ?? '' })
  }
  engine.progressEmitted = true

  if (ok) emitDone(engine, true)
  else emitDone(engine, false, message ?? t('main.zmodem.transferFailed'))
}

/**
 * Called by the zsession's own 'session_end' event (its `this` is the session).
 *
 * 'session_end' is the clean-finish signal ONLY when the peer ended it. Our own
 * session.abort() fires it synchronously too, and letting that through re-enters
 * finalize(ok=true) *before* the failing caller emits its own terminal events —
 * which reported every stalled / cancelled / failed transfer as a success
 * (progress state 'done', ZMODEM_DONE ok:true, no error message).
 */
function makeSessionEnd(engine: Engine): () => void {
  return () => {
    if (engine.ending) return
    finalize(engine, true)
  }
}

function touchActivity(engine: Engine): void {
  if (engine.stallTimer) clearTimeout(engine.stallTimer)
  const timer = setTimeout(() => {
    if (engine.stallTimer === null) return // already finalized
    finalize(engine, false, t('main.zmodem.transferTimeout'))
  }, STALL_TIMEOUT_MS)
  engine.stallTimer = timer
}

function wireSession(engine: Engine): void {
  const session = engine.session
  if (!session) return
  const sendToPeer = (octets: number[]): void => {
    try {
      engine.deps.writeStream(engine.id, Buffer.from(octets))
    } catch {
      // stream gone mid-transfer
    }
  }
  session.set_sender(sendToPeer)
  ;(session as unknown as { on: (event: string, cb: () => void) => void }).on('session_end', makeSessionEnd(engine))
  touchActivity(engine)
}

// ---------------------------------------------------------------------------
// Sending (remote `rz` -> we upload local files)
// ---------------------------------------------------------------------------

async function sendOneFile(
  engine: Engine,
  session: Zmodem.SendSession,
  file: { path: string; name: string; size: number; mtimeMs: number }
): Promise<void> {
  const xfer = await session.send_offer({
    name: file.name,
    size: file.size,
    mtime: new Date(file.mtimeMs),
    mode: undefined
  })
  if (!xfer) return // receiver skipped the file
  // Forced: a file boundary must always be visible even if the previous chunk
  // just consumed the throttle window.
  emitProgressThrottled(
    engine,
    { file: file.name, bytes: engine.bytes, totalBytes: engine.totalBytes },
    true
  )

  await new Promise<void>((resolve, reject) => {
    const rs = createReadStream(file.path)
    rs.on('data', (chunk: string | Buffer) => {
      rs.pause()
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      try {
        xfer.send(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength))
      } catch (err) {
        rs.destroy()
        reject(err instanceof Error ? err : new Error(t('main.zmodem.sendFailed')))
        return
      }
      engine.bytes += buf.length
      emitProgressThrottled(engine, {
        file: file.name,
        bytes: engine.bytes,
        totalBytes: engine.totalBytes
      })
      // Not throttled: the stall watchdog measures byte progress, not UI events.
      touchActivity(engine)
      rs.resume()
    })
    rs.on('end', () => {
      xfer
        .end()
        .then(() => resolve())
        .catch(reject)
    })
    rs.on('error', reject)
  })
}

/**
 * Upload the approved local files. `paths` are the paths the policy accepted
 * *and* resolved, so `createReadStream` opens exactly what was checked; the
 * name offered to the peer is the basename of that resolved path.
 */
async function runSend(engine: Engine, paths: string[]): Promise<void> {
  try {
    const session = engine.session as Zmodem.SendSession
    const files = await Promise.all(
      paths.map(async (p) => {
        const s = await stat(p)
        return { path: p, name: basename(p), size: s.size, mtimeMs: s.mtimeMs }
      })
    )
    engine.totalBytes = files.reduce((acc, f) => acc + f.size, 0)

    for (const f of files) {
      emitProgressThrottled(
        engine,
        { file: f.name, bytes: engine.bytes, totalBytes: engine.totalBytes },
        true
      )
      await sendOneFile(engine, session, f)
    }
    // Forced: the last running progress must show the true total before the
    // terminal event lands.
    emitProgressThrottled(
      engine,
      { file: '', bytes: engine.totalBytes, totalBytes: engine.totalBytes },
      true
    )
    // Final state + ZMODEM_DONE come from the session_end event fired by close().
    await session.close()
  } catch (err) {
    finalize(engine, false, err instanceof Error ? err.message : t('main.zmodem.uploadFailed'))
  }
}

// ---------------------------------------------------------------------------
// Receiving (remote `sz` -> we download into a chosen local directory)
// ---------------------------------------------------------------------------

function handleOffer(engine: Engine, offer: Zmodem.Offer): void {
  const details = offer.get_details()
  // The offered name is the PEER's string, so it is display data only: the path
  // actually written is decided by the policy below, which refuses anything that
  // is not a plain leaf inside the directory the user granted. `basename` keeps
  // the UI honest for a peer that sends a path rather than a name.
  const name = basename(String(details.name ?? 'file'))
  const dest = pathPolicy.writeTarget(engine.dir, name)
  if (dest === null) {
    // Refusing one file must not silently look like success: end the transfer
    // with the reason, which also stops the peer (finalize aborts the session).
    finalize(engine, false, t('main.zmodem.savePathNotAllowed', { name }))
    return
  }
  if (details.size) engine.totalBytes += details.size

  const stream = createWriteStream(dest)
  engine.receiveStream = stream
  emitProgress(engine, { file: name, bytes: engine.bytes, totalBytes: engine.totalBytes })

  // A dead sink (ENOSPC, EACCES, path deleted mid-transfer) must end the
  // transfer right here. Without this listener the 'error' event is unhandled
  // and takes the process down; even with a listener, skipping finalize leaves
  // the engine `active` — terminal output stays suppressed and keystrokes keep
  // being swallowed until the 90s stall watchdog finally fires.
  stream.on('error', (err: Error) => {
    // Only the stream the engine still owns may end the transfer: a late error
    // from a file a later offer already replaced (or from a finished transfer)
    // must not tear down the new one. It is still *handled* either way — an
    // unhandled 'error' is fatal.
    if (engine.receiveStream !== stream) return
    engine.receiveStream = null
    finalize(engine, false, err instanceof Error ? err.message : t('main.zmodem.receiveFailed'))
  })

  offer
    .accept({
      on_input: (payload: Uint8Array | number[]) => {
        // zmodem.js delivers the payload as a plain octet Array (not a
        // Uint8Array); coerce defensively to a Buffer before writing.
        const buf = Array.isArray(payload) ? Buffer.from(payload) : Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength)
        if (!stream.destroyed && !stream.closed) {
          stream.write(buf)
        }
        engine.bytes += buf.byteLength
        emitProgressThrottled(engine, {
          file: name,
          bytes: engine.bytes,
          totalBytes: engine.totalBytes
        })
        // Not throttled: the stall watchdog measures byte progress, not UI events.
        touchActivity(engine)
      }
    })
    .then(() => {
      // The sink may already be dead (write error, session teardown): end() on
      // a destroyed stream raises ERR_STREAM_DESTROYED.
      if (stream.destroyed || stream.writableEnded) return
      stream.end(() => {
        if (engine.receiveStream === stream) engine.receiveStream = null
        emitProgressThrottled(
          engine,
          { file: name, bytes: engine.bytes, totalBytes: engine.totalBytes },
          true
        )
      })
    })
    .catch((err: unknown) => {
      try {
        stream.destroy()
      } catch {
        // already gone
      }
      finalize(engine, false, err instanceof Error ? err.message : t('main.zmodem.receiveFailed'))
    })
}

// ---------------------------------------------------------------------------
// Public API (used by pty.ts / ipc.ts)
// ---------------------------------------------------------------------------

/**
 * Attach a ZMODEM Sentry to an ssh session. Only call for ssh sessions (see
 * module docs: local ptys are unsupported by design). deps are injected by
 * pty.ts so this module stays Electron-free.
 */
export function attachZmodem(sessionId: string, deps: ZmodemDeps): void {
  const engine: Engine = {
    id: sessionId,
    deps,
    sentry: new Zmodem.Sentry({
      to_terminal: (octets: number[]) => {
        // Analysis: also defensive against active http-parsing leftovers.
        if (engine.active) return // suppress binary terminal output during transfer
        try {
          deps.toTerminal(sessionId, Buffer.from(octets))
        } catch {
          // never crash the event loop
        }
      },
      on_detect: (detection: Zmodem.Detection) => {
        const role = detection.get_session_role()
        engine.mode = role === 'receive' ? 'receive' : 'send'
        engine.detection = detection
        engine.active = true
        // A detect is the start of a fresh transfer on this session, so the
        // one-shot flags of the previous one must go with it. Leaving `confirmed`
        // set made the *second* `sz`/`rz` on a session a no-op: respondZmodem
        // bailed out, the engine stayed `active` (swallowing every keystroke and
        // all terminal data) until the stall timer finally fired.
        engine.confirmed = false
        engine.progressEmitted = false
        engine.doneEmitted = false
        engine.dir = null
        engine.session = null
        engine.receiveStream = null
        engine.bytes = 0
        engine.totalBytes = 0
        engine.transferId = `zm-${sessionId}`
        // 0 = window open, so the first data chunk of the new transfer is
        // reported immediately instead of being swallowed by the previous
        // transfer's throttle window.
        engine.lastProgressAt = 0
        // The previous transfer may have ended by our own abort; this one starts
        // fresh, so its peer-driven 'session_end' must count again.
        engine.ending = false
        emitProgress(engine, { file: '', bytes: 0, totalBytes: 0 })
        try {
          deps.broadcast(Ipc.ZMODEM_OFFER, { id: sessionId, mode: engine.mode })
        } catch {
          // never crash the event loop
        }
        // Clear any previous offer timer first: a re-detect while an earlier
        // offer is still pending overwrites engine.offerTimer, and the orphaned
        // timer would fire at its original deadline and abort a legitimate
        // pending offer ahead of its own timeout.
        if (engine.offerTimer) clearTimeout(engine.offerTimer)
        engine.offerTimer = setTimeout(() => {
          if (engine.detection && !engine.confirmed) {
            abortWithoutSession(engine, t('main.zmodem.offerTimedOut'))
          }
        }, OFFER_TIMEOUT_MS)
      },
      on_retract: () => {
        // The detected "session" turned out not to be ZMODEM; return to normal.
        engine.detection = null
        engine.mode = null
        engine.active = false
        cancelTimers(engine)
      },
      sender: (octets: number[]) => {
        try {
          deps.writeStream(sessionId, Buffer.from(octets))
        } catch {
          // stream gone mid-transfer
        }
      }
    }),
    detection: null,
    session: null,
    active: false,
    mode: null,
    dir: null,
    confirmed: false,
    transferId: `zm-${sessionId}`,
    progressEmitted: false,
    lastProgressAt: 0,
    ending: false,
    doneEmitted: false,
    offerTimer: null,
    stallTimer: null,
    receiveStream: null,
    bytes: 0,
    totalBytes: 0
  }
  engines.set(sessionId, engine)
}

/**
 * Abort an unconfirmed (or pre-session) offer. No live zsession yet, so we write
 * the CAN abort sequence directly so the remote program exits.
 */
function abortWithoutSession(engine: Engine, message: string): void {
  engine.ending = true
  try {
    engine.detection?.deny()
  } catch {
    // already retracted or confirmed
  }
  engine.detection = null
  try {
    engine.deps.writeStream(engine.id, ABORT_BUFFER)
  } catch {
    // stream may be gone
  }
  engine.active = false
  cancelTimers(engine)
  if (!engine.progressEmitted) emitProgress(engine, { state: 'cancelled', file: message })
  engine.progressEmitted = true
  emitDone(engine, false, message)
}

/** Abort a confirmed session cleanly (sends CAN so remote rz/sz exits). */
function abortSession(engine: Engine, message: string): void {
  // Set before abort(): the abort fires 'session_end' synchronously and that
  // must not be taken as the peer completing the transfer.
  engine.ending = true
  try {
    engine.session?.abort()
  } catch {
    // fall through to write the abort sequence ourselves
  }
  try {
    engine.deps.writeStream(engine.id, ABORT_BUFFER)
  } catch {
    // stream may be gone
  }
  finalize(engine, false, message, 'cancelled')
}

/** Feed raw ssh-stream bytes into the engine. Only call when isZmodemActive(). */
export function feedZmodem(sessionId: string, data: Buffer): void {
  const engine = current(sessionId)
  if (!engine) return
  try {
    engine.sentry.consume(data)
  } catch (err) {
    // A zmodem.js Error (peer abort / corrupt frame) ends the session.
    if (!engine.doneEmitted) {
      finalize(engine, false, err instanceof Error ? err.message : t('main.zmodem.abnormal'))
    }
  }
}

/** Whether a zmodem transfer is active (pty.ts suppresses user writes while true). */
export function isZmodemActive(sessionId: string): boolean {
  return current(sessionId)?.active ?? false
}

/**
 * The renderer answered an offer (via ipc.ts). `cancelled` aborts; otherwise
 * the flow proceeds according to the detected mode.
 */
export function respondZmodem(resp: ZmodemResponse): void {
  const engine = current(resp.id)
  if (!engine || !engine.active || engine.confirmed) return

  if (resp.cancelled) {
    abortWithoutSession(engine, t('main.zmodem.cancelled'))
    return
  }

  const detection = engine.detection
  if (!detection || !detection.is_valid()) {
    abortWithoutSession(engine, t('main.zmodem.sessionInvalid'))
    return
  }

  engine.confirmed = true
  // The offer was answered — stop the offer watchdog; the stall timer takes over.
  if (engine.offerTimer) {
    clearTimeout(engine.offerTimer)
    engine.offerTimer = null
  }
  engine.session = detection.confirm()
  if (!engine.session) {
    abortWithoutSession(engine, t('main.zmodem.sessionCreateFailed'))
    return
  }
  wireSession(engine)

  if (engine.mode === 'receive') {
    if (!resp.dir) {
      abortSession(engine, t('main.zmodem.noSaveDir'))
      return
    }
    // The save directory came from the renderer: only one the user granted
    // through the dialog is usable (localPathGrants.ts). Resolved once here, so
    // every file of the transfer is written into the directory that was checked.
    const dir = pathPolicy.readDirectory(resp.dir)
    if (dir === null) {
      abortSession(engine, t('main.zmodem.saveDirNotAllowed'))
      return
    }
    engine.dir = dir
    const session = engine.session as Zmodem.ReceiveSession
    session.on('offer', (offer) => handleOffer(engine, offer))
    void session
      .start()
      .catch((err) =>
        finalize(engine, false, err instanceof Error ? err.message : t('main.zmodem.receiveFailed'))
      )
  } else {
    // Same for the files to send: the renderer supplies the paths, so each one
    // must be a file the user picked. Checked before the transfer starts —
    // rejecting mid-stream would leave the peer waiting on an abort.
    const paths = Array.isArray(resp.paths) ? resp.paths : []
    if (paths.length === 0) {
      abortSession(engine, t('main.zmodem.noFiles'))
      return
    }
    // All or nothing. Dropping just the refused entries would run a transfer
    // that reports success while quietly shipping fewer files than the user
    // selected.
    const allowed: string[] = []
    for (const p of paths) {
      const source = pathPolicy.readSource(p)
      if (source === null) {
        abortSession(engine, t('main.zmodem.filesNotAllowed'))
        return
      }
      allowed.push(source)
    }
    void runSend(engine, allowed)
  }
}

/**
 * Detach + clean up (session close / kill). Safe to call any number of times.
 *
 * A live transfer dies with the session, so it must be finalized here: nothing
 * else will ever answer the pending offer or finish the progress row, and the
 * renderer would keep its ZMODEM offer modal (and a `running` transfer entry)
 * up forever. Only `active` engines are finalized — an idle engine never
 * announced anything, and emitting a terminal event for every session close
 * would spam the UI with failures that never happened. finalize()/emitDone()
 * are one-shot, so a second detach (or a detach after the normal session_end)
 * emits nothing.
 */
export function detachZmodem(sessionId: string): void {
  const engine = current(sessionId)
  if (!engine) return
  if (engine.active) {
    finalize(engine, false, t('main.zmodem.sessionClosed'), 'cancelled')
  }
  engine.active = false
  cancelTimers(engine)
  const stream = engine.receiveStream
  engine.receiveStream = null
  if (stream && !stream.destroyed && !stream.writableEnded) {
    try {
      stream.end()
    } catch {
      // ignore
    }
  }
  engine.session = null
  engine.detection = null
  engines.delete(sessionId)
}