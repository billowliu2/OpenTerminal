/**
 * ZMODEM engine e2e (M6). In-process, no SSH server and no real credentials:
 * our engine (src/main/zmodem.ts) is attached to one end of an in-process wire,
 * and a SEPARATE zmodem.js Sentry plays the remote rz/sz on the other end. Two
 * full duplex directions are exercised over the real ZMODEM framing:
 *
 *   场景 1 (download): remote `sz` sends a file -> our engine receives it into
 *                      a temp dir; assert content matches + done(ok) + progress.
 *   场景 2 (upload):   our engine uploads a local temp file -> remote `rz`
 *                      receives it; assert remote content matches + done(ok).
 *   场景 3 (throttle): slow peer, 2KB every 3ms -> the running progress
 *                      broadcasts must stay under the 150ms floor.
 *   场景 4 (sink err): save dir does not exist -> createWriteStream errors, the
 *                      engine must finalize at once (not at the 90s stall) and
 *                      release the terminal data plane.
 *   场景 5 (detach):   session killed with an offer pending / a transfer in
 *                      flight -> detachZmodem must emit ZMODEM_DONE + a terminal
 *                      progress event, exactly once. Also asserts that cancelling
 *                      a confirmed session reports ok=false, not a fake success
 *                      (abort() fires 'session_end' synchronously).
 *
 * Pre-req (the bundle is built automatically on first run):
 *   npx esbuild src/main/zmodem.ts --bundle --platform=node --format=cjs \
 *     --external:ssh2 --alias:electron=./tests/electron-stub.cjs \
 *     --outfile=tests/.zmodem-e2e.cjs
 * zmodem.js stays bundled (NOT external).
 *
 * Run:   node tests/zmodem-e2e.mjs  (must exit 0)
 */
import { createRequire } from 'module'
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  rmSync,
  existsSync
} from 'fs'
import { join, dirname, resolve, basename } from 'path'
import { fileURLToPath } from 'url'
import { execFileSync } from 'child_process'
import { randomBytes } from 'crypto'

const __dirname = dirname(fileURLToPath(import.meta.url))
const require_ = createRequire(import.meta.url)
const fail = (msg) => {
  console.error(`FAIL: ${msg}`)
  process.exit(1)
}

// Temp dirs the scenarios create under tests/. They are removed on the way out,
// including when fail() exits the process mid-scenario — hence the exit hook
// next to the try/finally at the bottom.
const tempDirs = []
const mkTemp = (prefix) => {
  const dir = mkdtempSync(join(__dirname, prefix))
  tempDirs.push(dir)
  return dir
}
const cleanupTempDirs = () => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
}
process.on('exit', cleanupTempDirs)

// ---- 0. ensure bundle ---------------------------------------------------------
const bundlePath = join(__dirname, '.zmodem-e2e.cjs')
if (!existsSync(bundlePath)) {
  console.log('[zmodem-e2e] building bundle ...')
  const cmd = process.platform === 'win32' ? 'npx.cmd' : 'npx'
  execFileSync(
    cmd,
    [
      'esbuild', resolve(__dirname, '../src/main/zmodem.ts'),
      '--bundle', '--platform=node', '--format=cjs',
      '--external:ssh2',
      '--alias:electron=./tests/electron-stub.cjs',
      `--outfile=${bundlePath}`
    ],
    { stdio: 'inherit', shell: process.platform === 'win32' }
  )
}

const zmodem = require_('zmodem.js')
const engine = require_(bundlePath)

/**
 * Local-path admission for the engine. In the app the default policy only
 * accepts paths the user granted through a native dialog (localPathGrants.ts),
 * and this harness has no dialog to grant from — so the scenarios supply their
 * own double. It is deliberately permissive (and deliberately NOT a re-export
 * of the real policy, which is what keeps these scenarios about transfer
 * mechanics rather than admission rules).
 */
engine.setLocalPathPolicy({
  readSource: (p) => (typeof p === 'string' ? p : null),
  readDirectory: (d) => (typeof d === 'string' && d !== '' ? d : null),
  writeTarget: (dir, name) =>
    typeof dir === 'string' && dir !== '' && typeof name === 'string' && name !== ''
      ? join(dir, name)
      : null
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Drive a zmodem.js SEND session with a real file (the fs-port of the browser
 * send_files helper, used by the remote half of the download scenario).
 */
async function driveRemoteSend(session, filePath) {
  const data = readFileSync(filePath)
  const name = basename(filePath)
  const xfer = await session.send_offer({ name, size: data.length, mtime: new Date() })
  if (!xfer) throw new Error('offer was skipped')
  const CHUNK = 8192
  let off = 0
  if (data.length === 0) {
    await xfer.end(new Uint8Array(0))
  } else {
    while (off < data.length) {
      const end = Math.min(off + CHUNK, data.length)
      if (end < data.length) {
        xfer.send(new Uint8Array(data.buffer, data.byteOffset + off, end - off))
      } else {
        await xfer.end(new Uint8Array(data.buffer, data.byteOffset + off, end - off))
      }
      off = end
    }
  }
  await session.close()
}

/**
 * Same as driveRemoteSend, but paced: `chunkSize` bytes every `delayMs`. Keeps
 * the transfer running long enough for the progress throttle to be measurable
 * (zmodem.js caps a subpacket at 8192 bytes, so an unpaced transfer is over in
 * a few milliseconds and produces almost no events either way).
 */
async function driveRemoteSendPaced(session, filePath, chunkSize, delayMs) {
  const data = readFileSync(filePath)
  const name = basename(filePath)
  const xfer = await session.send_offer({ name, size: data.length, mtime: new Date() })
  if (!xfer) throw new Error('offer was skipped')
  let off = 0
  while (off < data.length) {
    const end = Math.min(off + chunkSize, data.length)
    const slice = new Uint8Array(data.buffer, data.byteOffset + off, end - off)
    if (end < data.length) {
      xfer.send(slice)
      await sleep(delayMs)
    } else {
      await xfer.end(slice)
    }
    off = end
  }
  await session.close()
}

/** Wait for the first event on `channel` (ms budget); returns its payload. */
async function waitForEvent(events, channel, budgetMs = 5000) {
  const deadline = Date.now() + budgetMs
  for (;;) {
    const hit = events.find((e) => e.channel === channel)
    if (hit) return hit.payload
    if (Date.now() >= deadline) return undefined
    await sleep(10)
  }
}

/**
 * Feed octets to the peer sentry. The peer's zsession throws "peer_aborted"
 * once our engine writes its abort CAN, which is the expected outcome in the
 * scenarios where the engine deliberately kills the transfer.
 */
function safeConsume(sentry, data) {
  try {
    sentry.consume(data)
  } catch {
    // peer aborted by our own CAN
  }
}

/** Attach our engine to a fake ssh session, collecting every broadcast. */
function attachCollecting(sessionId, writeStream) {
  const events = []
  engine.attachZmodem(sessionId, {
    broadcast: (channel, payload) => events.push({ channel, payload }),
    toTerminal: () => {},
    writeStream
  })
  return events
}

const progressOf = (events) =>
  events.filter((e) => e.channel === 'transfer:progress').map((e) => e.payload)
const doneOf = (events) => events.filter((e) => e.channel === 'zmodem:done').map((e) => e.payload)

/** Read all bytes a remote receive side has drained so far. */
function collectRemote(self) {
  return Buffer.concat(self._incoming)
}

/**
 * Build a remote (peer) Sentry. `remoteOnDetect(confirm)` wires the remote's
 * on_detect: it should confirm + drive its side. `routeOut` is called with the
 * octets the remote sent so we can feed them into our engine.
 */
function makeRemoteSentry(remoteOnDetect, routeOut) {
  const self = { _incoming: [] }
  const remoteSentry = new zmodem.Sentry({
    to_terminal: () => {},
    on_retract: () => {},
    on_detect: (detection) => remoteOnDetect(detection, self),
    sender: (octets) => routeOut(Buffer.from(octets))
  })
  self.sentry = remoteSentry
  self.consume = (buf) => {
    self._incoming.push(Buffer.from(buf))
  }
  return self
}

// ---- SCENARIO 1: download (remote `sz` -> our engine receives) ----------------
async function scenarioDownload() {
  console.log('\n=== 场景 1: 远端 sz + 本地接收 (download) ===')
  const sessionId = `sess-${randomBytes(3).toString('hex')}`
  const srcDir = mkTemp('.zm-src-dl-')
  const srcFile = join(srcDir, 'transferred.bin')
  const payload = randomBytes(200_000)
  writeFileSync(srcFile, payload)
  const outDir = mkTemp('.zm-out-dl-')

  const events = []
  const remote = makeRemoteSentry((detection) => {
    const s = detection.confirm()
    if (s.type === 'send') {
      // remote plays sz: send the source file, then finish
      driveRemoteSend(s, srcFile).catch((e) => fail(`remote send error: ${e}`))
    }
  }, (buf) => setTimeout(() => engine.feedZmodem(sessionId, buf), 0))

  engine.attachZmodem(sessionId, {
    broadcast: (channel, payload) => events.push({ channel, payload }),
    toTerminal: () => {},
    writeStream: (id, data) => setTimeout(() => remote.sentry.consume(data), 0)
  })

  // remote sz initiates with ZRQINIT
  engine.feedZmodem(sessionId, Buffer.from(zmodem.Header.build('ZRQINIT').to_hex()))

  // wait for the receive offer
  for (let i = 0; i < 200 && !events.some((e) => e.channel === 'zmodem:offer'); i++) await sleep(10)
  const offer = events.find((e) => e.channel === 'zmodem:offer')?.payload
  if (!offer) fail('download: no ZMODEM_OFFER received')
  if (offer.mode !== 'receive') fail(`download: expected receive offer, got ${offer.mode}`)
  console.log(`[download] offer received (mode=receive) id=${offer.id}`)

  engine.respondZmodem({ id: offer.id, cancelled: false, dir: outDir })

  // wait for done
  for (let i = 0; i < 200 && !events.some((e) => e.channel === 'zmodem:done'); i++) await sleep(10)
  const done = events.find((e) => e.channel === 'zmodem:done')?.payload
  if (!done) fail('download: no ZMODEM_DONE received')
  if (!done.ok) fail(`download: expected ok, got ${JSON.stringify(done)}`)

  // assert progress events flowed
  const prog = events.filter((e) => e.channel === 'transfer:progress').map((e) => e.payload)
  if (prog.length === 0) fail('download: no TRANSFER_PROGRESS emitted')
  if (prog[0].kind !== 'zmodem-download') fail(`download: expected zmodem-download kind, got ${prog[0].kind}`)
  const finalProg = prog[prog.length - 1]
  if (finalProg.state !== 'done') fail(`download: last progress not done (${finalProg.state})`)

  // assert content
  const got = readFileSync(join(outDir, 'transferred.bin'))
  if (got.length !== payload.length || !got.equals(payload)) {
    fail(`download: content mismatch (len ${got.length} vs ${payload.length})`)
  }
  console.log(`[download] file received: ${got.length} bytes, content matches`)
  console.log(`[download] progress events: ${prog.length} (state->done), done(ok)=true`)
}

// ---- SCENARIO 2: upload (our engine -> remote `rz`) ----------------------------
async function scenarioUpload() {
  console.log('\n=== 场景 2: 本地上传 + 远端 rz (upload) ===')
  const sessionId = `sess-${randomBytes(3).toString('hex')}`
  const srcDir = mkTemp('.zm-src-up-')
  const srcFile = join(srcDir, 'sendme.bin')
  const payload = randomBytes(150_000)
  writeFileSync(srcFile, payload)
  const outDir = mkTemp('.zm-out-up-')

  const events = []
  let remoteGot = null
  const remote = makeRemoteSentry((detection, self) => {
    const s = detection.confirm()
    if (s.type === 'receive') {
      // remote plays rz: accept the offered file, spool to disk.
      s.on('offer', (offer) => {
        const name = basename(offer.get_details().name)
        const chunks = []
        offer.on('input', (p) => chunks.push(Buffer.from(p)))
        offer
          .accept()
          .then(async () => {
            const data = Buffer.concat(chunks)
            writeFileSync(join(outDir, name), data)
            remoteGot = data
          })
          .catch((e) => fail(`remote receive error: ${e}`))
      })
      // start() once; zmodem.js re-sends ZRINIT itself after each accepted file.
      s.start().catch((e) => fail(`remote receive start error: ${e}`))
    }
  }, (buf) => setTimeout(() => engine.feedZmodem(sessionId, buf), 0))

  engine.attachZmodem(sessionId, {
    broadcast: (channel, payload) => events.push({ channel, payload }),
    toTerminal: () => {},
    writeStream: (id, data) => setTimeout(() => remote.sentry.consume(data), 0)
  })

  // remote rz receiver initiates: we feed it ZRQINIT so it detects "receive",
  // confirms and start()s, which sends ZRINIT toward our engine.
  remote.sentry.consume(Buffer.from(zmodem.Header.build('ZRQINIT').to_hex()))

  // engine should detect send and offer
  for (let i = 0; i < 200 && !events.some((e) => e.channel === 'zmodem:offer'); i++) await sleep(10)
  const offer = events.find((e) => e.channel === 'zmodem:offer')?.payload
  if (!offer) fail('upload: no ZMODEM_OFFER received')
  if (offer.mode !== 'send') fail(`upload: expected send offer, got ${offer.mode}`)
  console.log(`[upload] offer received (mode=send) id=${offer.id}`)

  engine.respondZmodem({ id: offer.id, cancelled: false, paths: [srcFile] })

  for (let i = 0; i < 200 && !events.some((e) => e.channel === 'zmodem:done'); i++) await sleep(10)
  const done = events.find((e) => e.channel === 'zmodem:done')?.payload
  if (!done) fail('upload: no ZMODEM_DONE received')
  if (!done.ok) fail(`upload: expected ok, got ${JSON.stringify(done)}`)

  const prog = events.filter((e) => e.channel === 'transfer:progress').map((e) => e.payload)
  if (prog.length === 0) fail('upload: no TRANSFER_PROGRESS emitted')
  if (prog[0].kind !== 'zmodem-upload') fail(`upload: expected zmodem-upload kind, got ${prog[0].kind}`)

  if (!remoteGot) fail('upload: remote never received the file data')
  if (remoteGot.length !== payload.length || !payload.equals(remoteGot)) {
    fail(`upload: content mismatch (remote ${remoteGot.length} vs src ${payload.length})`)
  }
  console.log(`[upload] remote received ${remoteGot.length} bytes, content matches`)
  console.log(`[upload] progress events: ${prog.length}, done(ok)=true`)
}

// ---- SCENARIO 3: progress throttle -------------------------------------------
async function scenarioThrottle() {
  console.log('\n=== 场景 3: 进度节流 (download, 慢速对端) ===')
  const sessionId = `sess-${randomBytes(3).toString('hex')}`
  const srcDir = mkTemp('.zm-src-thr-')
  const srcFile = join(srcDir, 'paced.bin')
  const payload = randomBytes(300_000)
  writeFileSync(srcFile, payload)
  const outDir = mkTemp('.zm-out-thr-')

  const remote = makeRemoteSentry(
    (detection) => {
      const s = detection.confirm()
      if (s.type === 'send') {
        // 2KB per tick => ~150 on_input calls: an unthrottled engine turns
        // every one of them into a broadcast.
        driveRemoteSendPaced(s, srcFile, 2048, 3).catch((e) => fail(`remote send error: ${e}`))
      }
    },
    (buf) => setTimeout(() => engine.feedZmodem(sessionId, buf), 0)
  )

  const events = attachCollecting(sessionId, (id, data) =>
    setTimeout(() => safeConsume(remote.sentry, data), 0)
  )
  engine.feedZmodem(sessionId, Buffer.from(zmodem.Header.build('ZRQINIT').to_hex()))

  const offer = await waitForEvent(events, 'zmodem:offer')
  if (!offer) fail('throttle: no ZMODEM_OFFER received')

  const t0 = Date.now()
  engine.respondZmodem({ id: offer.id, cancelled: false, dir: outDir })
  const done = await waitForEvent(events, 'zmodem:done')
  const elapsed = Date.now() - t0
  if (!done) fail('throttle: no ZMODEM_DONE received')
  if (!done.ok) fail(`throttle: expected ok, got ${JSON.stringify(done)}`)

  const got = readFileSync(join(outDir, 'paced.bin'))
  if (got.length !== payload.length || !got.equals(payload)) {
    fail(`throttle: content mismatch (len ${got.length} vs ${payload.length})`)
  }

  const prog = progressOf(events)
  // 150ms floor => at most one event per window, plus the deliberately forced
  // file-boundary/final events (4) and slack for timer jitter. Without the
  // throttle this is one event per subpacket (~150), so the gap is wide.
  const bound = Math.ceil(elapsed / 150) + 8
  if (prog.length > bound) {
    fail(`throttle: ${prog.length} progress events in ${elapsed}ms exceeds bound ${bound}`)
  }
  if (prog.length < 2) fail(`throttle: only ${prog.length} progress events, throttle too aggressive`)
  if (prog[prog.length - 1].state !== 'done') {
    fail(`throttle: last progress state ${prog[prog.length - 1].state}, expected done`)
  }
  console.log(`[throttle] ${prog.length} progress events in ${elapsed}ms (bound ${bound}), content matches`)
}

// ---- SCENARIO 4: dead write sink finalizes at once ---------------------------
async function scenarioWriteError() {
  console.log('\n=== 场景 4: 接收落盘失败 (目录不存在) -> 立即终结 ===')
  const sessionId = `sess-${randomBytes(3).toString('hex')}`
  const srcDir = mkTemp('.zm-src-err-')
  const srcFile = join(srcDir, 'fail.bin')
  writeFileSync(srcFile, randomBytes(120_000))
  const outDir = mkTemp('.zm-out-err-')
  // Never created: createWriteStream() emits ENOENT, the path a full disk or a
  // revoked permission would take.
  const badDir = join(outDir, 'no-such-dir')

  const remote = makeRemoteSentry(
    (detection) => {
      const s = detection.confirm()
      if (s.type === 'send') {
        // Paced on purpose: an unpaced in-process transfer finishes before the
        // fs.open ENOENT even surfaces, and the sink would only fail after the
        // session had already ended successfully. The engine aborts as soon as
        // the sink fails, so the peer dying here is the expected outcome, not a
        // test failure.
        driveRemoteSendPaced(s, srcFile, 4096, 5).catch(() => {})
      }
    },
    (buf) => setTimeout(() => engine.feedZmodem(sessionId, buf), 0)
  )

  const events = attachCollecting(sessionId, (id, data) =>
    setTimeout(() => safeConsume(remote.sentry, data), 0)
  )
  engine.feedZmodem(sessionId, Buffer.from(zmodem.Header.build('ZRQINIT').to_hex()))

  const offer = await waitForEvent(events, 'zmodem:offer')
  if (!offer) fail('write-error: no ZMODEM_OFFER received')

  const t0 = Date.now()
  engine.respondZmodem({ id: offer.id, cancelled: false, dir: badDir })
  // 2s budget: the point is that this does NOT wait for the 90s stall watchdog.
  const done = await waitForEvent(events, 'zmodem:done', 2000)
  if (!done) fail('write-error: no ZMODEM_DONE within 2s (engine stuck active?)')
  if (done.ok) {
    fail(`write-error: expected ok=false, got ${JSON.stringify(done)} — sink error lost the race`)
  }
  if (engine.isZmodemActive(sessionId)) {
    fail('write-error: engine still active — terminal data plane stays suppressed')
  }
  const prog = progressOf(events)
  const last = prog[prog.length - 1]
  if (last.state !== 'error') fail(`write-error: last progress state ${last.state}, expected error`)
  console.log(`[write-error] done(ok=false) after ${Date.now() - t0}ms, state=error, engine inactive`)
}

// ---- SCENARIO 5: detach (session killed) emits the terminal events ------------
async function scenarioDetach() {
  console.log('\n=== 场景 5: 会话被 kill -> detach 补发终结事件 ===')

  // (a) offer still pending: the renderer's modal is up and nothing will answer
  {
    const sessionId = `sess-${randomBytes(3).toString('hex')}`
    const events = attachCollecting(sessionId, () => {})
    engine.feedZmodem(sessionId, Buffer.from(zmodem.Header.build('ZRQINIT').to_hex()))
    const offer = await waitForEvent(events, 'zmodem:offer')
    if (!offer) fail('detach(pending): no ZMODEM_OFFER received')

    engine.detachZmodem(sessionId)
    const done = doneOf(events)
    if (done.length !== 1) fail(`detach(pending): expected 1 ZMODEM_DONE, got ${done.length}`)
    if (done[0].ok) fail('detach(pending): expected ok=false')
    if (engine.isZmodemActive(sessionId)) fail('detach(pending): engine still active')
    const prog = progressOf(events)
    if (prog[prog.length - 1].state !== 'cancelled') {
      fail(`detach(pending): last progress state ${prog[prog.length - 1].state}, expected cancelled`)
    }
    // Idempotent: the engine is already gone, a second detach emits nothing.
    engine.detachZmodem(sessionId)
    if (doneOf(events).length !== 1) fail('detach(pending): ZMODEM_DONE emitted twice')
    console.log('[detach] pending offer -> done(ok=false) + cancelled progress, idempotent')
  }

  // (b) transfer in flight
  {
    const sessionId = `sess-${randomBytes(3).toString('hex')}`
    const srcDir = mkTemp('.zm-src-det-')
    const srcFile = join(srcDir, 'killed.bin')
    writeFileSync(srcFile, randomBytes(200_000))
    const outDir = mkTemp('.zm-out-det-')

    let detached = false
    const remote = makeRemoteSentry(
      (detection) => {
        const s = detection.confirm()
        if (s.type === 'send') {
          // Killed mid-flight on purpose: a dying peer is expected here.
          driveRemoteSendPaced(s, srcFile, 2048, 3).catch(() => {})
        }
      },
      (buf) => {
        if (detached) return
        setTimeout(() => engine.feedZmodem(sessionId, buf), 0)
      }
    )

    const events = attachCollecting(sessionId, (id, data) => {
      if (detached) return
      setTimeout(() => remote.sentry.consume(data), 0)
    })
    engine.feedZmodem(sessionId, Buffer.from(zmodem.Header.build('ZRQINIT').to_hex()))
    const offer = await waitForEvent(events, 'zmodem:offer')
    if (!offer) fail('detach(live): no ZMODEM_OFFER received')

    engine.respondZmodem({ id: offer.id, cancelled: false, dir: outDir })
    if (!engine.isZmodemActive(sessionId)) fail('detach(live): engine not active after respond')

    const mark = events.length
    detached = true
    engine.detachZmodem(sessionId)
    await sleep(300)

    const done = doneOf(events)
    if (done.length !== 1) fail(`detach(live): expected 1 ZMODEM_DONE, got ${done.length}`)
    if (done[0].ok) fail('detach(live): expected ok=false')
    if (engine.isZmodemActive(sessionId)) fail('detach(live): engine still active')

    const after = progressOf(events.slice(mark))
    if (after.length === 0) fail('detach(live): no terminal progress emitted')
    if (after[after.length - 1].state !== 'cancelled') {
      fail(`detach(live): last progress state ${after[after.length - 1].state}, expected cancelled`)
    }
    if (after.some((p) => p.state === 'running')) {
      fail('detach(live): progress still running after detach')
    }
    engine.detachZmodem(sessionId)
    if (doneOf(events).length !== 1) fail('detach(live): ZMODEM_DONE emitted twice')
    console.log('[detach] live transfer -> done(ok=false) + cancelled progress, exactly once')
  }

  // (c) user cancels a *confirmed* session (no files chosen). abortSession()
  // aborts before it finalizes, and the abort fires 'session_end' synchronously:
  // without the engine.ending guard that re-entered finalize(ok=true) and the
  // cancel was reported as a successful transfer.
  {
    const sessionId = `sess-${randomBytes(3).toString('hex')}`
    const remote = makeRemoteSentry(
      (detection) => {
        const s = detection.confirm()
        if (s.type === 'receive') s.start().catch(() => {})
      },
      (buf) => setTimeout(() => engine.feedZmodem(sessionId, buf), 0)
    )
    const events = attachCollecting(sessionId, (id, data) =>
      setTimeout(() => safeConsume(remote.sentry, data), 0)
    )
    // Remote rz initiates: it detects "receive" from ZRQINIT, confirms and
    // start()s, which sends ZRINIT toward our engine.
    remote.sentry.consume(Buffer.from(zmodem.Header.build('ZRQINIT').to_hex()))

    const offer = await waitForEvent(events, 'zmodem:offer')
    if (!offer) fail('detach(cancel): no ZMODEM_OFFER received')
    if (offer.mode !== 'send') fail(`detach(cancel): expected send offer, got ${offer.mode}`)

    engine.respondZmodem({ id: offer.id, cancelled: false, paths: [] })
    const done = doneOf(events)
    if (done.length !== 1) fail(`detach(cancel): expected 1 ZMODEM_DONE, got ${done.length}`)
    if (done[0].ok) fail('detach(cancel): a cancelled transfer was reported as success')
    if (engine.isZmodemActive(sessionId)) fail('detach(cancel): engine still active')
    const prog = progressOf(events)
    if (prog[prog.length - 1].state !== 'cancelled') {
      fail(`detach(cancel): last progress state ${prog[prog.length - 1].state}, expected cancelled`)
    }
    console.log('[detach] confirmed session cancelled -> done(ok=false), no fake success')
  }
}

// ---- run ----------------------------------------------------------------------
const timer = setTimeout(() => fail('zmodem-e2e timed out'), 30000)
try {
  await scenarioDownload()
  await scenarioUpload()
  await scenarioThrottle()
  await scenarioWriteError()
  await scenarioDetach()
} finally {
  clearTimeout(timer)
  cleanupTempDirs()
}
console.log('\n[zmodem-e2e] ALL CHECKS PASSED')
process.exit(0)