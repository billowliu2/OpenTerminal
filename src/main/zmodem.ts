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
import { basename, join } from 'path'
import { createReadStream, createWriteStream } from 'fs'
import { stat } from 'fs/promises'
import type { Writable } from 'stream'
import * as Zmodem from 'zmodem.js'
import { Ipc } from '../shared/ipc'
import type { ZmodemDoneEvent, ZmodemResponse } from '../shared/ipc'
import type { TransferProgressEvent } from '../shared/sftp'

/** How long to wait for the renderer to answer a ZMODEM_OFFER (ms). */
const OFFER_TIMEOUT_MS = 120_000
/** Abort a transfer that makes no byte progress for this long (ms). */
const STALL_TIMEOUT_MS = 90_000

const ABORT_BUFFER = Buffer.from(Zmodem.ZMLIB.ABORT_SEQUENCE)

export interface ZmodemDeps {
  /** Emit a main->renderer broadcast (ZMODEM_OFFER / ZMODEM_DONE / TRANSFER_PROGRESS). */
  broadcast(channel: string, ...args: unknown[]): void
  /**
   * Forward NON-ZMODEM octets back through the normal terminal data path
   * (utf8 + replay + session log + PTY_DATA). pty.ts injects this; the engine
   * only calls it when no transfer is active.
   */
  toTerminal(sessionId: string, text: string): void
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
  cancelTimers(engine)
  if (engine.receiveStream) {
    try {
      engine.receiveStream.end()
    } catch {
      // already closed
    }
    engine.receiveStream = null
  }
  engine.session = null // the zsession already ended; drop the reference
  engine.detection = null

  if (!engine.progressEmitted) {
    emitProgress(engine, { state: ok ? 'done' : failState, file: message ?? '' })
  }
  engine.progressEmitted = true

  if (ok) emitDone(engine, true)
  else emitDone(engine, false, message ?? '传输失败')
}

/** Called by the zsession's own 'session_end' event (its `this` is the session). */
function makeSessionEnd(engine: Engine): () => void {
  return () => finalize(engine, true)
}

function touchActivity(engine: Engine): void {
  if (engine.stallTimer) clearTimeout(engine.stallTimer)
  const timer = setTimeout(() => {
    if (engine.stallTimer === null) return // already finalized
    finalize(engine, false, '传输超时')
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
  emitProgress(engine, { file: file.name, bytes: engine.bytes, totalBytes: engine.totalBytes })

  await new Promise<void>((resolve, reject) => {
    const rs = createReadStream(file.path)
    rs.on('data', (chunk: string | Buffer) => {
      rs.pause()
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      try {
        xfer.send(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength))
      } catch (err) {
        rs.destroy()
        reject(err instanceof Error ? err : new Error('发送失败'))
        return
      }
      engine.bytes += buf.length
      emitProgress(engine, { file: file.name, bytes: engine.bytes, totalBytes: engine.totalBytes })
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
      emitProgress(engine, { file: f.name, bytes: engine.bytes, totalBytes: engine.totalBytes })
      await sendOneFile(engine, session, f)
    }
    emitProgress(engine, { file: '', bytes: engine.totalBytes, totalBytes: engine.totalBytes })
    // Final state + ZMODEM_DONE come from the session_end event fired by close().
    await session.close()
  } catch (err) {
    finalize(engine, false, err instanceof Error ? err.message : '上传失败')
  }
}

// ---------------------------------------------------------------------------
// Receiving (remote `sz` -> we download into a chosen local directory)
// ---------------------------------------------------------------------------

function handleOffer(engine: Engine, offer: Zmodem.Offer): void {
  const details = offer.get_details()
  const name = basename(String(details.name ?? 'file'))
  const dest = join(engine.dir ?? '.', name)
  if (details.size) engine.totalBytes += details.size

  const stream = createWriteStream(dest)
  engine.receiveStream = stream
  emitProgress(engine, { file: name, bytes: engine.bytes, totalBytes: engine.totalBytes })

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
        emitProgress(engine, { file: name, bytes: engine.bytes, totalBytes: engine.totalBytes })
        touchActivity(engine)
      }
    })
    .then(() => {
      stream.end(() => {
        if (engine.receiveStream === stream) engine.receiveStream = null
        emitProgress(engine, { file: name, bytes: engine.bytes, totalBytes: engine.totalBytes })
      })
    })
    .catch((err: unknown) => {
      try {
        stream.destroy()
      } catch {
        // already gone
      }
      finalize(engine, false, err instanceof Error ? err.message : '接收失败')
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
          deps.toTerminal(sessionId, Buffer.from(octets).toString('utf8'))
        } catch {
          // never crash the event loop
        }
      },
      on_detect: (detection: Zmodem.Detection) => {
        const role = detection.get_session_role()
        engine.mode = role === 'receive' ? 'receive' : 'send'
        engine.detection = detection
        engine.active = true
        engine.transferId = `zm-${sessionId}`
        emitProgress(engine, { file: '', bytes: 0, totalBytes: 0 })
        try {
          deps.broadcast(Ipc.ZMODEM_OFFER, { id: sessionId, mode: engine.mode })
        } catch {
          // never crash the event loop
        }
        touchActivity(engine)
        engine.offerTimer = setTimeout(() => {
          if (engine.detection && !engine.confirmed) abortWithoutSession(engine, '未选择文件，已取消')
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
    if (!engine.doneEmitted) finalize(engine, false, err instanceof Error ? err.message : 'ZMODEM 传输异常')
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
  if (!engine || engine.confirmed) return

  if (resp.cancelled) {
    abortWithoutSession(engine, '已取消')
    return
  }

  const detection = engine.detection
  if (!detection || !detection.is_valid()) {
    abortWithoutSession(engine, '会话已失效')
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
    abortWithoutSession(engine, '无法建立 ZMODEM 会话')
    return
  }
  wireSession(engine)

  if (engine.mode === 'receive') {
    if (!resp.dir) {
      abortSession(engine, '未指定保存目录')
      return
    }
    engine.dir = resp.dir
    const session = engine.session as Zmodem.ReceiveSession
    session.on('offer', (offer) => handleOffer(engine, offer))
    void session
      .start()
      .catch((err) => finalize(engine, false, err instanceof Error ? err.message : '接收失败'))
  } else {
    const paths = resp.paths ?? []
    if (paths.length === 0) {
      abortSession(engine, '未选择文件')
      return
    }
    void runSend(engine, paths)
  }
}

/** Detach + clean up (session close / kill). Safe to call any number of times. */
export function detachZmodem(sessionId: string): void {
  const engine = current(sessionId)
  if (!engine) return
  engine.active = false
  cancelTimers(engine)
  if (engine.receiveStream) {
    try {
      engine.receiveStream.end()
    } catch {
      // ignore
    }
    engine.receiveStream = null
  }
  engine.session = null
  engine.detection = null
  engines.delete(sessionId)
}