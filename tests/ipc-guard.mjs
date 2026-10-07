/**
 * IPC sender-frame guard self-test (ipc-guard.mjs).
 *
 * `installSenderGuard` (src/main/ipc.ts) is the single choke point every IPC
 * channel in this app is registered through — four modules register handlers,
 * so the check lives where they all pass rather than at each site. It is what
 * keeps a frame that navigated away (or an injected one) from driving the main
 * process through the preload bridge, which is the app's whole API
 * (`createPty` included). What is pinned here:
 *
 *   - `isTrustedRendererUrl`: in a packaged build only the bundled renderer
 *     file's URL is trusted; in dev only the vite dev server's ORIGIN (any path
 *     on it, no other port / host). Malformed input is never trusted.
 *   - through the REAL registration path (`registerIpc` -> the stub's ipcMain),
 *     a trusted invoke resolves, an untrusted one rejects with the refused
 *     error instead of reaching the handler, and a missing `senderFrame`
 *     (Electron gives `null` for a destroyed frame) is refused too.
 *   - untrusted `send`-style channels are dropped without calling the listener.
 *   - the guard is installed once, not stacked per registration.
 *
 * Build: node tests/build-bundles.cjs
 * Run:   node tests/ipc-guard.mjs   (must exit 0)
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const userData = mkdtempSync(join(tmpdir(), 'ot-ipc-'))
process.env.OT_STUB_USERDATA = userData

const require = createRequire(import.meta.url)
const stub = require('./electron-stub.cjs')
const { registerIpc, isTrustedRendererUrl } = require('./.ipc.cjs')
const { Ipc } = require('./.ipc-channels.cjs')

let failed = 0
let passed = 0
const ok = (cond, msg) => {
  console.log(`  ${cond ? 'ok' : 'FAIL'}: ${msg}`)
  if (!cond) failed += 1
  else passed += 1
}

const DEV_URL = 'http://localhost:5173'
const withDevUrl = (value, fn) => {
  const prev = process.env.ELECTRON_RENDERER_URL
  if (value === undefined) delete process.env.ELECTRON_RENDERER_URL
  else process.env.ELECTRON_RENDERER_URL = value
  try {
    return fn()
  } finally {
    if (prev === undefined) delete process.env.ELECTRON_RENDERER_URL
    else process.env.ELECTRON_RENDERER_URL = prev
  }
}

// The URL a packaged build loads: the renderer file next to the main bundle.
// The test's bundle sits in tests/, the app's in out/main/, so this is the
// `../renderer/index.html` sibling either way.
const PACKAGED_URL = pathToFileURL(join(__dirname, '../renderer/index.html')).href

// ---- 1. the trust predicate -------------------------------------------------
console.log('trusted renderer URL (packaged build: the renderer file and nothing else)')
withDevUrl(undefined, () => {
  ok(isTrustedRendererUrl(PACKAGED_URL), 'the bundled renderer file is trusted')
  ok(!isTrustedRendererUrl(pathToFileURL(join(__dirname, '../renderer/other.html')).href), 'a sibling file in the renderer dir is not')
  ok(!isTrustedRendererUrl(pathToFileURL(join(__dirname, '../package.json')).href), 'another local file is not')
  ok(!isTrustedRendererUrl('file:///C:/Windows/System32/drivers/etc/hosts'), 'an unrelated file: URL is not')
  ok(!isTrustedRendererUrl('https://evil.example/index.html'), 'a remote origin is not')
  ok(!isTrustedRendererUrl('http://localhost:5173/'), 'the dev server is NOT trusted in a packaged build (env ignored)')
})

console.log('trusted renderer URL (dev build: the dev server origin, any path)')
withDevUrl(DEV_URL, () => {
  ok(isTrustedRendererUrl(`${DEV_URL}/index.html`), 'a path on the dev origin is trusted')
  ok(isTrustedRendererUrl(`${DEV_URL}/`), 'the dev origin root is trusted')
  ok(isTrustedRendererUrl(`${DEV_URL}/deep/nested/route?x=1#y`), 'any path/query/hash on that origin is trusted')
  ok(!isTrustedRendererUrl('http://localhost:5174/index.html'), 'a different port is a different origin')
  ok(!isTrustedRendererUrl('http://127.0.0.1:5173/index.html'), 'a different host spelling is a different origin')
  ok(!isTrustedRendererUrl('https://localhost:5173/index.html'), 'a different scheme is a different origin')
  ok(!isTrustedRendererUrl('https://evil.example/http://localhost:5173/'), 'a hostile URL embedding the dev URL is not the dev origin')
  ok(!isTrustedRendererUrl(PACKAGED_URL), 'the packaged file URL is not the dev origin')
})

console.log('the predicate refuses everything malformed')
withDevUrl(DEV_URL, () => {
  for (const raw of ['', 'not a url', '://', 'about:blank', 'javascript:alert(1)', 'data:text/html,x', 'file://']) {
    ok(!isTrustedRendererUrl(raw), `refused: ${JSON.stringify(raw)}`)
  }
})

// ---- 2. the guard, through the real registration path -----------------------
console.log('the guard on a registered channel')
registerIpc()

const handlers = stub.__handlers
const trustedFrame = { url: `${DEV_URL}/index.html` }
const hostileFrame = { url: 'https://evil.example/hijack.html' }
const invoke = (channel, frame, ...args) => {
  const listener = handlers.get(channel)
  if (!listener) throw new Error(`no handler registered for ${channel}`)
  return listener({ senderFrame: frame, sender: { id: 1 } }, ...args)
}

withDevUrl(DEV_URL, () => {
  ok(typeof handlers.get(Ipc.APP_INFO) === 'function', 'APP_INFO reached the registration path')
  ok(handlers.get(Ipc.APP_INFO) !== undefined, 'the stub recorded a handler (registrations are not dropped)')

  // The trusted path really executes the handler: it returns the app info
  // object instead of rejecting.
  const info = invoke(Ipc.APP_INFO, trustedFrame)
  ok(
    info && typeof info === 'object' && typeof info.platform === 'string' && info.appVersion === '0.0.0-stub',
    `a trusted frame reaches the handler (got ${JSON.stringify(info)})`
  )

  // Path validation inside a handler still applies to a trusted frame: this
  // handler refuses non-strings, so a compromised-but-trusted renderer cannot
  // open an arbitrary path.
  ok(invoke(Ipc.CWD_OPEN, trustedFrame, 'not-a-path') === false, 'handler-level validation still runs for a trusted frame')
  ok(invoke(Ipc.CWD_OPEN, trustedFrame, undefined) === false, 'CWD_OPEN refuses a missing path')
  ok(invoke(Ipc.CWD_OPEN, trustedFrame, 42) === false, 'CWD_OPEN refuses a non-string path')

  const refused = (channel, ...args) => {
    try {
      invoke(channel, hostileFrame, ...args)
      return null
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    }
  }

  let msg = refused(Ipc.APP_INFO)
  ok(typeof msg === 'string' && msg.includes('untrusted frame'), `an untrusted invoke is refused (${msg})`)
  ok(typeof msg === 'string' && msg.includes(Ipc.APP_INFO), 'the refusal names the channel (so it is diagnosable)')

  // A hostile frame gets the same refusal on every other invoke channel, and the
  // handler is never reached: CWD_OPEN would have thrown/misbehaved, PTY_CREATE
  // would have spawned a shell.
  for (const channel of [Ipc.CWD_OPEN, Ipc.PTY_CREATE, Ipc.CONNECTIONS_LIST, Ipc.SETTINGS_GET, Ipc.LOCK_STATE_GET]) {
    if (!handlers.has(channel)) continue
    const m = refused(channel)
    ok(typeof m === 'string' && m.includes('untrusted frame'), `refused on ${channel}`)
  }

  const missingFrame = (() => {
    try {
      handlers.get(Ipc.APP_INFO)({ sender: { id: 1 } }, )
      return null
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    }
  })()
  ok(
    typeof missingFrame === 'string' && missingFrame.includes('untrusted frame'),
    'a missing senderFrame (destroyed frame -> null) is refused'
  )

  // ---- 3. send-style channels are dropped, not rejected ---------------------
  // LOG_OPEN_DIR (ipcMain.on) has an observable side effect: it creates the
  // logs directory. That makes "the listener really did/did not run"
  // checkable, instead of asserting on the absence of a throw.
  const send = (frame, ...args) => {
    const listener = handlers.get(`on:${Ipc.LOG_OPEN_DIR}`)
    if (!listener) throw new Error('LOG_OPEN_DIR was not registered through ipcMain.on')
    listener({ senderFrame: frame, sender: { id: 1 } }, ...args)
  }
  const logsDir = join(userData, 'logs')

  ok(typeof handlers.get(`on:${Ipc.LOG_OPEN_DIR}`) === 'function', 'LOG_OPEN_DIR is registered through ipcMain.on (and therefore guarded)')

  send(hostileFrame)
  ok(!existsSync(logsDir), 'an untrusted send is dropped silently — the listener never ran')

  let threw = false
  try {
    send({ url: 'not a url' })
    send(undefined)
  } catch {
    threw = true
  }
  ok(!threw && !existsSync(logsDir), 'send on a malformed / missing frame is dropped, not thrown')

  send(trustedFrame)
  ok(existsSync(logsDir), 'a trusted send reaches the listener (the logs dir was created)')
})

// ---- 4. installed once ------------------------------------------------------
// `installSenderGuard` swaps `ipcMain.handle` / `ipcMain.on` for guarded
// wrappers. If it did not short-circuit on the second call, each registration
// would be wrapped again and the guard would nest — cheap here, but it also
// means a handler added after the first registerIpc could be guarded twice
// while one added before is guarded once, and the two spellings of the same
// check would drift. The wrapper identity is the observable proof.
console.log('the guard is installed once, not stacked')
withDevUrl(DEV_URL, () => {
  const handleRef = stub.ipcMain.handle
  const onRef = stub.ipcMain.on
  registerIpc()
  ok(stub.ipcMain.handle === handleRef, 'a second registerIpc does not re-wrap ipcMain.handle')
  ok(stub.ipcMain.on === onRef, 'a second registerIpc does not re-wrap ipcMain.on')

  const m = (() => {
    try {
      handlers.get(Ipc.APP_INFO)({ senderFrame: hostileFrame, sender: { id: 1 } })
      return null
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    }
  })()
  ok(typeof m === 'string' && m.includes('untrusted frame'), 'and an untrusted invoke is still refused after re-registering')

  // The duplicated refusals must not multiply: one layer, one message.
  ok((m.match(/untrusted frame/g) ?? []).length === 1, 'the refusal message is not nested (exactly one guard layer)')
})

rmSync(userData, { recursive: true, force: true })

if (failed > 0) {
  console.error(`\n[ipc-guard] ${failed} check(s) FAILED`)
  process.exit(1)
}
console.log(`\n[ipc-guard] ALL CHECKS PASSED (${passed} assertions)`)
