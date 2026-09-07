/**
 * SSH loopback verification (M2). Pure Node ESM, no Electron.
 *
 * Spins up an in-process ssh2.Server (127.0.0.1, random port), then connects
 * with a plain ssh2.Client using the exact same connect parameters the main
 * process ssh service uses (host/port/username/password/keepalive/hostVerifier),
 * and confirms the full data plane round-trip:
 *
 *   ready -> shell -> banner "LOOPBACK-OK" -> write data -> echo -> close
 *
 * Run: `node tests/ssh-loopback.mjs`  (must exit 0)
 */

import pkg from 'ssh2'
const { Server, Client, utils } = pkg
import { createHash } from 'crypto'

function fingerprintOf(key) {
  return 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
}

const fail = (msg) => {
  console.error(`FAIL: ${msg}`)
  process.exit(1)
}

// ---- 1. Boot the loopback server -------------------------------------------
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
    client.on('session', (accept, reject) => {
      const session = accept()
      session.on('pty', (accept) => accept())
      session.on('window-change', (accept, reject, info) => {
        seenWindowChange = { cols: info.cols, rows: info.rows }
        accept && accept()
      })
      session.on('shell', (accept, reject) => {
        const stream = accept()
        stream.write('LOOPBACK-OK\n')
        stream.on('data', (d) => {
          const data = d.toString('utf8')
          stream.write(data) // echo back
          if (data.includes('exit')) {
            stream.end()
            client.end()
          }
        })
      })
    })
  })

  client.on('error', (err) => console.error('[server] client error', err.message))
})

await new Promise((resolve, reject) => {
  srv.on('error', reject)
  srv.listen(0, '127.0.0.1', () => {
    serverPort = srv.address().port
    resolve()
  })
})
console.log(`[loopback] ssh server listening on 127.0.0.1:${serverPort}`)

// ---- 2. Connect with the same params the main ssh service uses --------------
const client = new Client()
let bannerSeen = false
let echoed = false
let output = ''
let verifyCalls = 0
let resolveDone
const done = new Promise((r) => (resolveDone = r))
const timer = setTimeout(() => {
  fail(`timed out (client connected: ${client._stream ? 'yes' : 'no'})`)
}, 10000)

client.on('ready', () => {
  console.log('[loopback] client ready')
  client.shell({ term: 'xterm-256color', cols: 80, rows: 24 }, (err, stream) => {
    if (err) return fail(`shell error: ${err.message}`)
    console.log('[loopback] shell open')
    let sentInput = false
    let sentExit = false

    stream.on('data', (d) => {
      const chunk = d.toString('utf8')
      output += chunk
      if (output.includes('LOOPBACK-OK') && !sentInput) {
        bannerSeen = true
        console.log('[loopback] banner received')
        // exercise resize while the session is live
        stream.setWindow(40, 120, 0, 0)
        sentInput = true
        stream.write('hello loopback\n')
      }
      if (output.includes('hello loopback') && echoed === false) {
        echoed = true
        console.log('[loopback] echo received')
      }
      if (bannerSeen && echoed && !sentExit) {
        sentExit = true
        stream.write('exit\n')
      }
    })

    stream.on('close', () => {
      clearTimeout(timer)
      console.log('[loopback] stream closed')
      client.end()
      resolveDone()
    })
  })
})

client.on('error', (err) => fail(`client error: ${err.message}`))

// hostVerifier mirrors ssh.ts (SHA256 fingerprint; loopback accepts the key)
client.connect({
  host: '127.0.0.1',
  port: serverPort,
  username: 'test',
  password: 'test',
  keepaliveInterval: 0,
  hostVerifier: (hostKey, verify) => {
    verifyCalls++
    const fp = fingerprintOf(hostKey)
    console.log(`[loopback] hostVerifier called (${verifyCalls}), fp=${fp}`)
    verify(true)
  }
})

// ---- 3. Assertions ----------------------------------------------------------
await done
srv.close()

const checks = [
  ['client reached ready', bannerSeen],
  ['banner LOOPBACK-OK received', bannerSeen],
  ['typed data echoed back', echoed],
  ['host key verified exactly once', verifyCalls === 1],
  ['resize propagated to server (40x120)', seenWindowChange.cols === 120 && seenWindowChange.rows === 40]
]

let ok = true
for (const [label, pass] of checks) {
  console.log(`[loopback] ${pass ? 'PASS' : 'FAIL'}: ${label}`)
  if (!pass) ok = false
}

if (!ok) fail('one or more checks failed')
console.log('[loopback] ALL CHECKS PASSED')
process.exit(0)