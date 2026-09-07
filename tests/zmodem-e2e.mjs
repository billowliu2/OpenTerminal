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
  const srcDir = mkdtempSync(join(__dirname, '.zm-src-dl-'))
  const srcFile = join(srcDir, 'transferred.bin')
  const payload = randomBytes(200_000)
  writeFileSync(srcFile, payload)
  const outDir = mkdtempSync(join(__dirname, '.zm-out-dl-'))

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

  rmSync(srcDir, { recursive: true, force: true })
  rmSync(outDir, { recursive: true, force: true })
}

// ---- SCENARIO 2: upload (our engine -> remote `rz`) ----------------------------
async function scenarioUpload() {
  console.log('\n=== 场景 2: 本地上传 + 远端 rz (upload) ===')
  const sessionId = `sess-${randomBytes(3).toString('hex')}`
  const srcDir = mkdtempSync(join(__dirname, '.zm-src-up-'))
  const srcFile = join(srcDir, 'sendme.bin')
  const payload = randomBytes(150_000)
  writeFileSync(srcFile, payload)
  const outDir = mkdtempSync(join(__dirname, '.zm-out-up-'))

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

  rmSync(srcDir, { recursive: true, force: true })
  rmSync(outDir, { recursive: true, force: true })
}

// ---- run ----------------------------------------------------------------------
const timer = setTimeout(() => fail('zmodem-e2e timed out'), 30000)
await scenarioDownload()
await scenarioUpload()
clearTimeout(timer)
console.log('\n[zmodem-e2e] ALL CHECKS PASSED')
process.exit(0)