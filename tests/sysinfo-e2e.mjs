/**
 * Sysinfo polling e2e (M3). Drives the REAL M3 engine (src/main/sysinfo.ts,
 * reached through pty.ts's re-export) against an in-process ssh2.Server whose
 * `exec(accept)` responds with canned /proc-style text. Verifies the META
 * broadcast, growing samples (usage + net rates), and that stopPolling halts
 * the stream.
 *
 * Pre-req: npx esbuild src/main/pty.ts --bundle --platform=node --format=cjs
 *          --outfile=tests/.session-e2e.cjs --external:@lydell/node-pty
 *          --external:ssh2 --alias:electron=./tests/electron-stub.cjs
 * Run:     node tests/sysinfo-e2e.mjs  (must exit 0)
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
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- 1. Loopback ssh server with canned /proc exec -----------------------------
const serverKey = utils.generateKeyPairSync('ed25519')
let serverPort = 0

// Two successive outputs with rising cpu ticks and rx/tx bytes so rates compute.
let execCount = 0
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
      session.on('shell', (accept) => {
        const stream = accept()
        stream.write('SYSINFO-E2E-BANNER\n')
        stream.on('data', () => {})
      })
      session.on('exec', (accept, reject, info) => {
        if (!info || typeof info.command !== 'string') {
          reject && reject()
          return
        }
        const stream = accept()
        execCount += 1
        const rising = execCount > 1
        const rxBytes = (rising ? 80 * 1024 * 1024 : 40 * 1024 * 1024) // 64KB/s basis
        const txBytes = (rising ? 32 * 1024 * 1024 : 16 * 1024 * 1024)
        const user = rising ? 4000 : 2000
        const idle = rising ? 8000 : 6000
        const idle2 = rising ? 8950 : 6000
        const idle3 = rising ? 9600 : 7500
        const out =
          `cpu  ${user} 100 500 ${idle} 120 30 20 0 0 0\n` +
          `cpu0 ${user} 100 500 ${idle} 120 30 20 0 0 0\n` +
          `cpu1 ${user} 100 500 ${idle2} 120 30 20 0 0 0\n` +
          `cpu2 ${user} 100 500 ${idle3} 120 30 20 0 0 0\n` +
          `irq 0 0 0 0 0 0 0 0 0 0\n` +
          `MemTotal:        ${4000000} kB\n` +
          `MemFree:         1000000 kB\n` +
          `MemAvailable:    ${3100000} kB\n` +
          `Buffers:          100000 kB\n` +
          '0.15 0.12 0.10 1/234 5678\n' +
          '12345.67 9876.54\n' +
          `__DF__\n` +
          'Filesystem     1K-blocks    Used Available Use% Mounted on\n' +
          '/dev/sda1       10240000 2048000   8192000  20% /\n' +
          'tmpfs           2048000       128   2047872   1% /dev/shm\n' +
          'overlay          10240000 2048000   8192000  20% /overlay\n' +
          '/dev/nvme0n1p3   51200000 12800000  38400000  25% /home\n' +
          `__NET__\n` +
          `Inter-|   Receive                                                |  Transmit\n` +
          ` face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n` +
          `    lo: ${rxBytes}   1000    0    0 0     0          0         0  ${txBytes}   1000    0    0    0     0       0          0\n` +
          `  eth0: ${rxBytes}   5000    0    0 0     0          0         0  ${txBytes}   2000    0    0    0     0       0          0\n` +
          `__HOST__\n` +
          'loopback-host\n' +
          'Linux 6.8.0-45-generic x86_64\n'
        stream.write(out)
        stream.exit(0)
        stream.end()
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
console.log(`[sysinfo] ssh server listening on 127.0.0.1:${serverPort}`)

// ---- 2. Load the real session layer + sysinfo engine ---------------------------
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
  touch: () => {},
  knownHosts: {
    check: (host, port, key) => {
      const fp = 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
      return { status: 'match', fingerprint: fp }
    },
    accept: () => {}
  },
  promptHostKey: () => fail('promptHostKey must not fire for matching keys')
})

const timer = setTimeout(() => fail('sysinfo e2e timed out'), 20000)

const openResult = await sessionLayer.openSession({ kind: 'ssh', connectionId: 'conn-1' })
if (!openResult?.id) fail('openSession did not resolve with an id')
console.log(`[sysinfo] session open: ${openResult.id}`)

const seenMeta = (id) =>
  events.some((e) => e.channel === 'sysinfo:meta' && e.payload?.id === id)
const samples = (id) =>
  events.filter((e) => e.channel === 'sysinfo:sample' && e.payload?.id === id).map((e) => e.payload.sample)

// ---- 3. Start polling -----------------------------------------------------------
sessionLayer.startPolling(openResult.id, 200)

// META once the first sample has fields to build it from.
for (let i = 0; i < 100 && !seenMeta(openResult.id); i++) await wait(50)
if (!seenMeta(openResult.id)) fail('SYSINFO_META never broadcast')
const meta = events.find((e) => e.channel === 'sysinfo:meta' && e.payload?.id === openResult.id).payload.meta
if (meta.hostname !== 'loopback-host') fail(`meta.hostname wrong: ${meta.hostname}`)
if (!meta.os.includes('Linux') || !meta.os.includes('6.8.0')) fail(`meta.os wrong: ${meta.os}`)
console.log(`[sysinfo] SYSINFO_META ok: hostname=${meta.hostname} os="${meta.os}"`)

// At least two SYSINFO_SAMPLE.
for (let i = 0; i < 100 && samples(openResult.id).length < 2; i++) await wait(50)
const got = samples(openResult.id)
if (got.length < 2) fail(`expected >=2 samples, got ${got.length}`)
const first = got[0]
const second = got[1]

if (first.cpu.usage !== 0) fail(`first sample cpu.usage must be 0, got ${first.cpu.usage}`)
if (first.net.rxKbs !== 0 || first.net.txKbs !== 0) fail('first sample net rates must be 0')

if (!(second.cpu.usage > 0 && second.cpu.usage <= 100)) fail(`second cpu.usage out of range: ${second.cpu.usage}`)
if (!(second.net.rxKbs > 0 && second.net.rxKbs < 1_000_000)) fail(`second net.rxKbs unreasonable: ${second.net.rxKbs}`)
  if (!(second.net.txKbs > 0 && second.net.txKbs < 1_000_000)) fail(`second net.txKbs unreasonable: ${second.net.txKbs}`)
if (second.cpu.cores !== 3) fail(`cpu.cores should be 3, got ${second.cpu.cores}`)
if (second.mem.totalMb !== Math.round(4000000 / 1024)) fail(`mem.totalMb wrong: ${second.mem.totalMb}`)
if (second.uptimeSec !== 12346 && second.uptimeSec !== 12345) fail(`uptimeSec wrong: ${second.uptimeSec}`)
// df must skip tmpfs + overlay pseudofs; only the two real mounts remain.
const mounts = second.disks.map((d) => d.mount).sort()
if (mounts.length !== 2 || mounts[0] !== '/' || mounts[1] !== '/home') {
  fail(`df mounts wrong (pseudofs not filtered?): ${JSON.stringify(mounts)}`)
}
console.log(
  `[sysinfo] samples ok: usage=${second.cpu.usage.toFixed(1)} cores=${second.cpu.cores} ` +
    `rx=${second.net.rxKbs.toFixed(1)}kB/s tx=${second.net.txKbs.toFixed(1)}kB/s disks=${mounts.join(',')}`
)

// ---- 4. Stop polling: no further samples -----------------------------------------
const before = samples(openResult.id).length
sessionLayer.stopPolling(openResult.id)
await wait(400)
const after = samples(openResult.id).length
if (after !== before) fail(`stopPolling did not halt: got ${after - before} new samples`)
console.log('[sysinfo] stopPolling halts the sample stream')

clearTimeout(timer)
srv.close()
console.log('[sysinfo] ALL CHECKS PASSED')
process.exit(0)