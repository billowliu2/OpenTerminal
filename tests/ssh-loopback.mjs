/**
 * SSH loopback verification (M2). Pure Node ESM, no Electron.
 *
 * Spins up an in-process ssh2.Server (127.0.0.1, random port) and drives the
 * SHIPPED connect path — `connectSsh` from src/main/ssh.ts, loaded through
 * tests/.ssh.cjs (build-bundles.cjs) — rather than a hand-copied ConnectConfig.
 * ssh.ts is deliberately Electron-free (`SshServiceDeps` injects the store, the
 * broadcast and the host-key prompt), so the real module can be exercised here
 * with no Chromium and no stubs. What that buys: the connect parameters, the
 * host-key verifier, the async prompt handshake and the auth gates are all the
 * code the app runs, not a copy that can silently drift from it.
 *
 * Covered:
 *   - happy path: connect -> auth -> shell -> banner "LOOPBACK-OK" -> write ->
 *     echo -> resize -> close, with the pinned key accepted without a prompt
 *   - TOFU: an unknown key asks the renderer (promptHostKey), and accepting it
 *     pins the key through knownHosts.accept before the handshake resumes
 *   - a rejected key aborts the connect with a user-facing reason
 *   - an unreadable store fails CLOSED without offering an accept
 *   - a store whose check() throws is treated the same way (never 'new')
 *   - a prompt nobody answers times out to a refusal
 *   - an unreachable port is bounded by the connect timeout
 *   - the auth gate: a connect-time password must NOT authenticate a
 *     privateKey bookmark, a passphrase must NOT leak into password auth
 *
 * Build: node tests/build-bundles.cjs
 * Run:   node tests/ssh-loopback.mjs   (must exit 0)
 */

import pkg from 'ssh2'
const { Server, utils } = pkg
import { createHash } from 'crypto'
import { createServer as createNetServer } from 'node:net'
import { createRequire } from 'module'

const require_ = createRequire(import.meta.url)
const { connectSsh, resolveHostKey } = require_('./.ssh.cjs')

function fingerprintOf(key) {
  return 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
}

/**
 * `utils.generateKeyPairSync().public` is the OpenSSH TEXT form
 * (`ssh-ed25519 AAAA…`), while ssh2's `hostVerifier` receives the raw wire
 * blob — the base64 payload of that text, decoded. Converting here keeps the
 * fingerprint assertions about the key the client was actually offered.
 */
const wireKeyOf = (publicKey) => Buffer.from(String(publicKey).trim().split(/\s+/)[1], 'base64')

let failed = 0
let passed = 0
const ok = (cond, msg) => {
  console.log(`  ${cond ? 'ok' : 'FAIL'}: ${msg}`)
  if (!cond) failed += 1
  else passed += 1
}

const fail = (msg) => {
  console.error(`FAIL: ${msg}`)
  process.exit(1)
}

// ---- 1. Boot the loopback server -------------------------------------------
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
let serverHostKey = null

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

  client.on('error', (err) => {
    // Rejected keys and refused auths are expected; not a harness failure.
    void err
  })
})

await new Promise((resolve, reject) => {
  srv.on('error', reject)
  srv.listen(0, '127.0.0.1', () => {
    serverPort = srv.address().port
    resolve()
  })
})
console.log(`[loopback] ssh server listening on 127.0.0.1:${serverPort}`)

// ---- 2. Sanity: the bundle really is the shipped module --------------------
{
  ok(
    /^SHA256:[A-Za-z0-9+/]{43}$/.test(fingerprintOf(wireKeyOf(serverKey.public))),
    'the harness fingerprint matches the OpenSSH SHA256 form (43 chars, no padding)'
  )
  ok(typeof connectSsh === 'function', 'connectSsh was loaded from the real src/main/ssh.ts bundle')
  ok(typeof resolveHostKey === 'function', 'resolveHostKey was loaded from the same bundle')
}

// ---- 3. deps ---------------------------------------------------------------
/** Records everything the service asks the outside world for. */
const makeDeps = (over = {}) => {
  const seen = {
    prompts: [],
    accepted: [],
    touched: [],
    broadcasts: []
  }
  return {
    seen,
    deps: {
      connections: {
        getSecret: () => over.secret,
        touch: (id) => seen.touched.push(id)
      },
      knownHosts: {
        check: over.check ?? (() => ({ status: 'match' })),
        accept: (host, port, key, fingerprint) => seen.accepted.push({ host, port, fingerprint })
      },
      broadcast: (channel, ...args) => seen.broadcasts.push({ channel, args }),
      promptHostKey: (prompt) => seen.prompts.push(prompt),
      timeoutMs: over.timeoutMs
    }
  }
}

const connection = (over = {}) => ({
  id: 'loopback',
  name: 'loopback',
  host: '127.0.0.1',
  port: serverPort,
  username: 'test',
  auth: 'password',
  askPasswordAtConnect: false,
  askPassphraseAtConnect: false,
  keepaliveIntervalSec: 0,
  createdAt: Date.now(),
  savedAuth: { hasPassword: true, hasKeyContent: false, hasPassphrase: false },
  ...over
})

/** Run a connect and report whether it resolved. */
const tryConnect = async (conn, secretOverride, over) => {
  const { seen, deps } = makeDeps({ secret: 'test', ...over })
  try {
    const handle = await connectSsh(conn, secretOverride, deps)
    return { handle, seen }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err), seen }
  }
}

// ---- 4. happy path: pinned key, no prompt ----------------------------------
console.log('happy path: connect, auth, shell, data plane, resize')
{
  const { handle, error, seen } = await tryConnect(connection(), undefined)
  if (error) fail(`connect failed: ${error}`)
  ok(handle?.id !== undefined, 'the service resolved with a session id')
  ok(handle.client !== undefined && typeof handle.stream?.write === 'function', 'the handle carries the client and the shell stream')
  ok(handle.exitCode === 0, 'a fresh session starts with exit code 0')
  ok(seen.prompts.length === 0, 'a pinned (status match) key is accepted without prompting the user')
  ok(seen.touched.includes('loopback'), 'the bookmark is touched (lastConnectedAt) on a successful connect')
  ok(seen.accepted.length === 0, 'an already-pinned key is not re-pinned')

  const output = await new Promise((resolve, reject) => {
    let text = ''
    let sentInput = false
    const timer = setTimeout(() => reject(new Error(`timed out, saw: ${JSON.stringify(text)}`)), 8000)
    handle.stream.on('data', (d) => {
      text += d.toString('utf8')
      if (text.includes('LOOPBACK-OK') && !sentInput) {
        sentInput = true
        // exercise resize while the session is live
        handle.stream.setWindow(40, 120, 0, 0)
        handle.stream.write('hello loopback\n')
      }
      if (text.includes('hello loopback') && text.includes('LOOPBACK-OK')) {
        clearTimeout(timer)
        resolve(text)
      }
    })
    handle.stream.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
  })
  ok(output.includes('LOOPBACK-OK'), 'the server banner arrived ("LOOPBACK-OK")')
  ok(output.includes('hello loopback'), 'typed data was echoed back through the real shell')

  // Resize reached the server (the server only records the last window-change).
  const resized = await new Promise((resolve) => {
    const started = Date.now()
    const tick = () => {
      if (seenWindowChange.cols === 120 && seenWindowChange.rows === 40) return resolve(true)
      if (Date.now() - started > 3000) return resolve(false)
      setTimeout(tick, 20)
    }
    tick()
  })
  ok(resized, `resize propagated to the server (40x120, saw ${JSON.stringify(seenWindowChange)})`)

  await new Promise((resolve) => {
    handle.stream.on('close', resolve)
    handle.stream.write('exit\n')
    setTimeout(resolve, 3000)
  })
  try {
    handle.client.end()
  } catch {
    /* already gone */
  }
}

// ---- 5. TOFU: unknown key is prompted, accepted, then pinned ---------------
console.log('TOFU: an unknown host key is prompted and pinned on accept')
{
  const check = () => ({ status: 'new' })
  const { seen, deps } = makeDeps({ secret: 'test', check })
  const pending = connectSsh(connection(), undefined, deps)

  // The handshake is paused inside hostVerifier until we answer.
  const prompt = await waitFor(() => seen.prompts[0], 5000)
  ok(prompt !== undefined, 'the renderer was asked to decide on the new key')
  ok(prompt?.host === '127.0.0.1' && prompt?.port === serverPort, 'the prompt names the host and port')
  ok(prompt?.reason === 'new', "the prompt reason is 'new' for an unknown key")
  ok(prompt?.fingerprint === fingerprintOf(wireKeyOf(serverKey.public)), 'the prompt carries the SHA256 fingerprint of the key actually offered')
  ok(typeof prompt?.promptId === 'string' && prompt.promptId.length > 0, 'the prompt carries an id to answer with')

  // Nothing may be pinned before the user decides.
  ok(seen.accepted.length === 0, 'the key is not pinned while the decision is outstanding')

  resolveHostKey(prompt.promptId, 'accept')
  const handle = await pending
  ok(handle?.id !== undefined, 'the connect resumed and succeeded after the accept')
  ok(seen.accepted.length === 1, 'the accepted key was pinned exactly once')
  ok(seen.accepted[0].fingerprint === fingerprintOf(wireKeyOf(serverKey.public)), 'the pinned fingerprint is the one shown to the user')
  ok(seen.accepted[0].host === '127.0.0.1' && seen.accepted[0].port === serverPort, 'the key is pinned for the right host:port')
  try {
    handle.client.end()
  } catch {
    /* already gone */
  }
}

console.log('an answer that arrives after the handshake failed is ignored (not pinned)')
{
  // The prompt is answered, but the transport dies first: pinning then would
  // record trust for a connection that never completed.
  const check = () => ({ status: 'new' })
  const { seen, deps } = makeDeps({ secret: 'test', check })
  const conn = connection({ port: 1 }) // nothing listens there
  const pending = connectSsh(conn, undefined, deps)
  // Wait for the transport to fail (or for the prompt, whichever comes first).
  const settled = await Promise.race([
    pending.then(() => 'resolved', () => 'rejected'),
    new Promise((r) => setTimeout(() => r('pending'), 3000))
  ])
  ok(settled === 'rejected' || settled === 'pending', `the dead-port connect did not succeed (${settled})`)
  const prompt = seen.prompts[0]
  if (prompt) {
    resolveHostKey(prompt.promptId, 'accept')
    await new Promise((r) => setTimeout(r, 100))
  }
  ok(seen.accepted.length === 0, 'no fingerprint was pinned for a connect that never completed')
  await pending.catch(() => undefined)
}

// ---- 6. reject / unreadable / throwing store -------------------------------
console.log('a rejected key aborts the connect with a user-facing reason')
{
  const check = () => ({ status: 'new' })
  const { seen, deps } = makeDeps({ secret: 'test', check })
  const pending = connectSsh(connection(), undefined, deps)
  const prompt = await waitFor(() => seen.prompts[0], 5000)
  ok(prompt !== undefined, 'the user was prompted')
  resolveHostKey(prompt.promptId, 'reject')
  const r = await pending.then(() => null, (e) => e.message)
  ok(typeof r === 'string', 'the connect was refused')
  ok(r.includes('127.0.0.1') && r.includes(String(serverPort)), `the refusal names the host:port (${r})`)
  ok(seen.accepted.length === 0, 'nothing was pinned for a rejected key')
}

console.log('an unreadable store fails CLOSED without offering an accept')
{
  const check = () => ({ status: 'unreadable' })
  const { seen } = await tryConnect(connection(), undefined, { check })
  ok(seen.prompts.length === 0, 'the user is NOT offered an accept when the store cannot be read')
  ok(seen.accepted.length === 0, 'nothing is pinned into a store we failed to load')
}

console.log('a store whose check() throws is treated as unreadable, never as new')
{
  const check = () => {
    throw new Error('boom')
  }
  const { error, seen } = await tryConnect(connection(), undefined, { check })
  ok(typeof error === 'string', 'the connect failed')
  ok(seen.prompts.length === 0, 'a throwing store does NOT become a prompt (falling back to "new" would rewrite the store)')
  ok(seen.accepted.length === 0, 'and nothing is pinned')
}

console.log('an accept that fails to persist refuses the connection')
{
  const check = () => ({ status: 'new' })
  const { seen, deps } = makeDeps({ secret: 'test', check })
  deps.knownHosts.accept = () => {
    throw new Error('disk full')
  }
  const pending = connectSsh(connection(), undefined, deps)
  const prompt = await waitFor(() => seen.prompts[0], 5000)
  resolveHostKey(prompt.promptId, 'accept')
  const r = await pending.then(() => null, (e) => e.message)
  ok(typeof r === 'string', 'the connect was refused rather than proceeding unpinned')
  ok(r.includes('127.0.0.1'), `the refusal names the host (${r})`)
}

// ---- 7. timeouts -----------------------------------------------------------
console.log('a prompt nobody answers times out into a refusal')
{
  const check = () => ({ status: 'new' })
  const started = Date.now()
  const { error, seen } = await tryConnect(connection(), undefined, {
    check,
    timeoutMs: { prompt: 120, connect: 5000 }
  })
  const elapsed = Date.now() - started
  ok(seen.prompts.length === 1, 'the user was asked')
  ok(typeof error === 'string', 'the unanswered prompt became a refusal')
  ok(elapsed < 3000, `the prompt budget decided it, not the connect budget (${elapsed}ms)`)
}

console.log('an unreachable port is bounded by the connect timeout')
{
  // A TCP server that accepts the connection and then says nothing: the SSH
  // handshake never starts, which is the shape a dropped firewall produces.
  const sockets = new Set()
  const blackhole = createNetServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => undefined)
  })
  await new Promise((r) => blackhole.listen(0, '127.0.0.1', r))
  const port = blackhole.address().port
  const started = Date.now()
  const { error } = await tryConnect(connection({ port }), undefined, {
    timeoutMs: { prompt: 1000, connect: 250 }
  })
  const elapsed = Date.now() - started
  ok(typeof error === 'string', 'the stalled handshake was refused')
  ok(error.includes('127.0.0.1') && error.includes(String(port)), `the refusal names the host:port (${error})`)
  ok(elapsed < 3000, `it gave up at the connect budget (${elapsed}ms)`)
  // `close()` only calls back once every accepted socket is gone, and the
  // abandoned client left one behind — drop them explicitly.
  for (const socket of sockets) socket.destroy()
  await new Promise((r) => blackhole.close(r))
}

// ---- 8. auth gates ---------------------------------------------------------
console.log('the auth gates hold')
{
  // A stored password on a privateKey bookmark must not be offered.
  const { error } = await tryConnect(connection({ auth: 'privateKey' }), undefined)
  ok(typeof error === 'string', 'a key-auth bookmark with only a stored password cannot authenticate')

  // A connect-time typed password must not upgrade a key-auth bookmark either.
  const { error: e2 } = await tryConnect(connection({ auth: 'privateKey' }), { password: 'test' })
  ok(typeof e2 === 'string', 'a typed password does not authenticate a key-auth bookmark (the gate above)')

  // A typed password DOES authenticate a password bookmark (secretOverride path).
  const { handle, seen } = await tryConnect(connection(), { password: 'test' })
  ok(handle?.id !== undefined, 'a typed connect-time password authenticates a password bookmark')
  ok(seen.touched.includes('loopback'), 'and the session is a normal successful connect')
  try {
    handle.client.end()
  } catch {
    /* already gone */
  }

  // Wrong password is refused by the server, and reported as a connect failure.
  const { error: e3 } = await tryConnect(connection(), undefined, { secret: 'wrong' })
  ok(typeof e3 === 'string' && e3.includes('127.0.0.1'), `a wrong password is reported as a connect failure (${e3})`)
}

console.log('an unparseable private key is refused at connect, not thrown into the void')
{
  const { error } = await tryConnect(connection({ auth: 'privateKey' }), undefined, {
    secret: 'not a key'
  })
  ok(typeof error === 'string', 'the connect was refused')
  ok(error.includes('127.0.0.1'), `the refusal names the host (${error})`)
}

// ---- 9. broadcasting --------------------------------------------------------
console.log('the renderer prompt goes out over the injected broadcast surface')
{
  const check = () => ({ status: 'new' })
  const { seen, deps } = makeDeps({ secret: 'test', check })
  const pending = connectSsh(connection(), undefined, deps)
  const prompt = await waitFor(() => seen.prompts[0], 5000)
  ok(prompt !== undefined, 'promptHostKey was called through deps (the app wires it to broadcast)')
  resolveHostKey(prompt.promptId, 'accept')
  await pending.catch(() => undefined)
  ok(seen.broadcasts.length === 0, 'the service itself does not broadcast (pty.ts owns the session events)')
}

// ---- teardown ---------------------------------------------------------------
srv.close()

if (failed > 0) {
  console.error(`\n[loopback] ${failed} check(s) FAILED`)
  process.exit(1)
}
console.log(`\n[loopback] ALL CHECKS PASSED (${passed} assertions)`)
process.exit(0)

function waitFor(pred, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now()
    const tick = () => {
      const value = pred()
      if (value !== undefined) return resolve(value)
      if (Date.now() - started > timeoutMs) return resolve(undefined)
      setTimeout(tick, 10)
    }
    tick()
  })
}
