/**
 * Session-layer e2e (M2). Drives the REAL session routing (src/main/pty.ts +
 * src/main/ssh.ts, bundled by esbuild with an electron stub) against an
 * in-process ssh2.Server — the same openSession/write/resize/kill pipeline the
 * app uses, minus the IPC + renderer shells.
 *
 * Pre-req: node tests/build-bundles.cjs   (or, by hand:)
 *   npx esbuild src/main/pty.ts --bundle --platform=node --format=cjs
 *     --outfile=tests/.session-e2e.cjs --external:@lydell/node-pty
 *     --external:ssh2 --alias:electron=./tests/electron-stub.cjs
 *     --alias:@shared=./src/shared
 *   (--alias:@shared=./src/shared is required: pty.ts reaches @shared/theme
 *   through settingsStore.ts -> windowChrome.ts)
 * Run:     node tests/ssh-session-e2e.mjs  (must exit 0)
 */

import pkg from 'ssh2'
import { createHash } from 'crypto'
import { createRequire } from 'module'
const require_ = createRequire(import.meta.url)
const { Server, utils } = pkg

const fail = (msg) => {
  console.error(`FAIL: ${msg}`)
  process.exit(1)
}

// ---- 1. Loopback ssh server --------------------------------------------------
// ssh2's ed25519 keygen turns out a malformed key roughly once per few
// hundred runs — its own parser then rejects it ("Malformed OpenSSH private
// key"), which is enough to flake a release build's pretest. The Server
// constructor parses hostKeys eagerly, so generate until one is accepted.
function newHostKey() {
  for (let attempt = 0; ; attempt++) {
    const pair = utils.generateKeyPairSync('ed25519')
    try {
      new Server({ hostKeys: [pair.private] }, () => {})
      return pair
    } catch (err) {
      if (attempt >= 9) throw err
    }
  }
}
const serverKey = newHostKey()
let serverPort = 0
let seenWindowChange = { cols: 0, rows: 0 }

// Latest server-side connection, so a test can hang up on the transport under
// an established session (see the PTY_EXIT guard near the end).
let serverSideClient = null

const srv = new Server({ hostKeys: [serverKey.private] }, (client) => {
  serverSideClient = client
  client.on('authentication', (ctx) => {
    if (ctx.method === 'password' && ctx.username === 'test' && ctx.password === 'test') {
      ctx.accept()
    } else {
      ctx.reject(['password'])
    }
  })
  client.on('ready', () => {
    client.on('session', (accept) => {
      const session = accept()
      session.on('pty', (accept) => accept())
      session.on('window-change', (accept, reject, info) => {
        seenWindowChange = { cols: info.cols, rows: info.rows }
        accept && accept()
      })
      session.on('shell', (accept) => {
        const stream = accept()
        stream.write('SESSION-E2E-BANNER\n')
        stream.on('data', (d) => {
          const data = d.toString('utf8')
          stream.write(data)
          if (data.includes('exit')) {
            stream.end()
            client.end()
          }
        })
      })
    })
  })
  client.on('error', () => {})
})

await new Promise((resolve, reject) => {
  srv.on('error', reject)
  srv.listen(0, '127.0.0.1', () => {
    serverPort = srv.address().port
    resolve()
  })
})
console.log(`[e2e] ssh server listening on 127.0.0.1:${serverPort}`)

// ---- 2. Load the real session layer ------------------------------------------
// esbuild replaces 'electron' with tests/electron-stub.cjs via --alias.
const sessionLayer = require_('./.session-e2e.cjs')

const events = []
sessionLayer.configureSessionRuntime({
  broadcast: (channel, payload) => events.push({ channel, payload }),
  getConnection: (id) => {
    if (id !== 'conn-1') fail(`unexpected connectionId ${id}`)
    return {
      id: 'conn-1',
      name: 'loopback',
      host: '127.0.0.1',
      port: serverPort,
      username: 'test',
      auth: 'password',
      askPasswordAtConnect: false,
      askPassphraseAtConnect: false,
      keepaliveIntervalSec: 0,
      createdAt: Date.now(),
      savedAuth: { hasPassword: true, hasKeyContent: false, hasPassphrase: false }
    }
  },
  getSecret: (conn, field) => (field === 'password' ? 'test' : undefined),
  touch: (id) => events.push({ channel: 'touched', payload: id }),
  knownHosts: {
    check: (host, port, key) => {
      const fp = 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
      return { status: 'match', fingerprint: fp }
    },
    accept: () => {}
  },
  promptHostKey: () => fail('promptHostKey must not fire for matching keys')
})

// ---- 3. Drive the pipeline ----------------------------------------------------
const timer = setTimeout(() => fail('e2e timed out'), 25000)
const openResult = await sessionLayer.openSession({ kind: 'ssh', connectionId: 'conn-1' })
if (!openResult?.id) fail('openSession did not resolve with an id')
console.log(`[e2e] session open: ${openResult.id}`)

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const seenData = (needle) =>
  events.some((e) => e.channel === 'pty:data' && typeof e.payload?.data === 'string' && e.payload.data.includes(needle))

// banner should already have streamed once the shell opened
for (let i = 0; i < 50 && !seenData('SESSION-E2E-BANNER'); i++) await wait(100)
if (!seenData('SESSION-E2E-BANNER')) fail('banner never arrived via PTY_DATA broadcast')
console.log('[e2e] banner received through session data plane')

// replay buffer: a late subscriber must still get the banner
const replay = await sessionLayer.getSessionReplay(openResult.id)
if (!replay.includes('SESSION-E2E-BANNER')) fail('replay buffer missing the banner')
console.log('[e2e] replay buffer serves the banner to late subscribers')

sessionLayer.writePty(openResult.id, 'ping-session-e2e\n')
for (let i = 0; i < 50 && !seenData('ping-session-e2e'); i++) await wait(100)
if (!seenData('ping-session-e2e')) fail('written data never echoed back')
console.log('[e2e] write -> echo round-trip ok')

sessionLayer.resizePty(openResult.id, 111, 33)
for (let i = 0; i < 50 && seenWindowChange.cols !== 111; i++) await wait(100)
if (seenWindowChange.cols !== 111 || seenWindowChange.rows !== 33) fail(`resize not propagated (${JSON.stringify(seenWindowChange)})`)
console.log('[e2e] resize propagated (111x33)')

sessionLayer.killPty(openResult.id)
const exited = events.find((e) => e.channel === 'pty:exit' && e.payload?.id === openResult.id)
if (!exited) {
  // 'close' on the client stream may lag slightly behind kill
  for (let i = 0; i < 50 && !events.some((e) => e.channel === 'pty:exit' && e.payload?.id === openResult.id); i++) await wait(100)
}
if (!events.some((e) => e.channel === 'pty:exit' && e.payload?.id === openResult.id)) fail('PTY_EXIT never broadcast after killPty')
console.log('[e2e] kill -> PTY_EXIT ok')

if (!events.some((e) => e.channel === 'touched' && e.payload === 'conn-1')) fail('lastConnectedAt touch not recorded')
console.log('[e2e] connection touch recorded')

// ---- 4. Transport death under an established session -------------------------
// pty.ts's teardown is now the ONLY PTY_EXIT broadcaster (ssh.ts dropped its own
// emit), so this is the guard for both failure modes: a teardown that never
// fires leaves the renderer's panel stuck on "connecting" forever, and a broken
// idempotence guard would broadcast the exit twice.
const open2 = await sessionLayer.openSession({ kind: 'ssh', connectionId: 'conn-1' })
if (!open2?.id) fail('second openSession did not resolve with an id')
for (let i = 0; i < 50 && !(await sessionLayer.getSessionReplay(open2.id)).includes('SESSION-E2E-BANNER'); i++) {
  await wait(100)
}
if (!(await sessionLayer.getSessionReplay(open2.id)).includes('SESSION-E2E-BANNER')) {
  fail('second session never became established')
}
console.log('[e2e] second session established')

const exitCount = (id) =>
  events.filter((e) => e.channel === 'pty:exit' && e.payload?.id === id).length
if (exitCount(open2.id) !== 0) fail('PTY_EXIT arrived before the transport died')

// The server hangs up. The client stream must land in the teardown path, which
// owns the single broadcast; the waits below give 'close' a moment to arrive.
serverSideClient.end()
for (let i = 0; i < 50 && exitCount(open2.id) === 0; i++) await wait(100)
if (exitCount(open2.id) !== 1) {
  fail(`transport death must broadcast PTY_EXIT exactly once, got ${exitCount(open2.id)}`)
}
console.log('[e2e] transport death -> PTY_EXIT exactly once')

clearTimeout(timer)
srv.close()
console.log('[e2e] ALL CHECKS PASSED')
process.exit(0)
