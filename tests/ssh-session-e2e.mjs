/**
 * Session-layer e2e (M2). Drives the REAL session routing (src/main/pty.ts +
 * src/main/ssh.ts, bundled by esbuild with an electron stub) against an
 * in-process ssh2.Server — the same openSession/write/resize/kill pipeline the
 * app uses, minus the IPC + renderer shells.
 *
 * Pre-req: npx esbuild src/main/pty.ts --bundle --platform=node --format=cjs
 *          --outfile=tests/.session-e2e.cjs --external:@lydell/node-pty
 *          --external:ssh2 --alias:electron=./tests/electron-stub.cjs
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
const serverKey = utils.generateKeyPairSync('ed25519')
let serverPort = 0
let seenWindowChange = { cols: 0, rows: 0 }

const srv = new Server({ hostKeys: [serverKey.private] }, (client) => {
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
const timer = setTimeout(() => fail('e2e timed out'), 15000)
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

clearTimeout(timer)
srv.close()
console.log('[e2e] ALL CHECKS PASSED')
process.exit(0)
