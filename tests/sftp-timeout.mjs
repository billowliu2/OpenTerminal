/**
 * SFTP timeout self-test (sftp-timeout.mjs).
 *
 * A half-dead SFTP channel — the peer is gone but no FIN was ever delivered,
 * which mobile / NAT'd links produce constantly — accepts a request and then
 * never calls back. ssh2 has no socket timeout of its own, so before this the
 * operation (and the spinner behind it) waited forever. `src/main/sftp.ts` now
 * bounds every operation, with two budgets because one number cannot serve
 * both: metadata round trips are milliseconds on a working link, while a 256KB
 * transfer chunk is legitimately seconds on a slow one.
 *
 * The test drives the real `withSftp` path with a fake ssh2 SFTP wrapper, so the
 * assertions are about the service's behavior: which budget applies, that a
 * timeout is transport-classified (channel evicted + ONE retry on a fresh
 * channel), that a late reply cannot resurrect an abandoned operation, and that
 * a slow-but-progressing transfer is never mistaken for a dead one.
 *
 * Build: node tests/build-bundles.cjs
 * Run:   node tests/sftp-timeout.mjs   (must exit 0)
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const sftp = await import('./.sftp-svc.mjs')

let failed = 0
let passed = 0
const ok = (cond, msg) => {
  console.log(`  ${cond ? 'ok' : 'FAIL'}: ${msg}`)
  if (!cond) failed += 1
  else passed += 1
}

// ---- harness ----------------------------------------------------------------
sftp.setSftpTimeouts({ op: 60, transfer: 200, open: 60 })
// Local-path admission is exercised by its own test; this harness picks its own
// temp paths and has no dialog to grant from.
const root = mkdtempSync(join(tmpdir(), 'ot-sftp-timeout-'))
sftp.setLocalPathPolicy({
  readSource: (p) => (typeof p === 'string' && p !== '' ? p : null),
  readDirectory: (d) => (typeof d === 'string' && d !== '' ? d : null),
  writeTarget: (dir, name) =>
    typeof dir === 'string' && dir !== '' && typeof name === 'string' && name !== ''
      ? join(dir, name)
      : null
})

/**
 * A fake ssh2 SFTPWrapper whose per-call behavior is scripted.
 * `behaviour(op, args)` returns `'silent'` (never calls back — the dead-channel
 * case), `'error'` (calls back with an error), or `'ok'` (calls back with
 * `result`). Every call is recorded so the test can assert on what was opened.
 */
const defaultStat = () => ({
  isDirectory: () => false,
  size: 10,
  mtime: 1_700_000_000,
  mode: 0o100644,
  uid: 1000,
  gid: 1000
})

let calls
let behaviour
let openedChannels
const makeWrapper = () => {
  const wrapper = {
    lstat: (p, cb) => dispatch('lstat', [p], cb, defaultStat()),
    readdir: (p, cb) => dispatch('readdir', [p], cb, ['a.txt', 'b.txt']),
    mkdir: (p, cb) => dispatch('mkdir', [p], cb, undefined, true),
    rename: (a, b, cb) => dispatch('rename', [a, b], cb, undefined, true),
    unlink: (p, cb) => dispatch('unlink', [p], cb, undefined, true),
    rmdir: (p, cb) => dispatch('rmdir', [p], cb, undefined, true),
    stat: (p, cb) => dispatch('stat', [p], cb, defaultStat()),
    open: (p, flags, cb) => dispatch('open', [p, flags], cb, Buffer.from('handle')),
    close: (h, cb) => dispatch('close', [h], cb, undefined, true),
    read: (h, buf, off, len, pos, cb) => {
      const verdict = behaviour('read', [h, off, len, pos])
      calls.push({ op: 'read', args: [off, len, pos] })
      if (verdict === 'silent') return
      if (verdict === 'error') return cb(new Error('read failed'))
      const answer = () => {
        // Two chunks, then EOF, so a healthy download terminates.
        if (pos >= 512) return cb(null, { bytesRead: 0, buffer: buf })
        buf.fill(0x41, off, off + 256)
        cb(null, { bytesRead: 256, buffer: buf })
      }
      // 'slow': answer after the metadata budget but inside the transfer one —
      // a slow link, which must NOT be treated as a dead channel.
      if (verdict === 'slow') setTimeout(answer, 120)
      else answer()
    },
    write: (h, buf, off, len, pos, cb) => dispatch('write', [h, len, pos], cb, undefined, true),
    end: () => calls.push({ op: 'end' }),
    on: () => wrapper
  }
  const dispatch = (op, args, cb, result, voidResult = false) => {
    calls.push({ op, args })
    const verdict = behaviour(op, args)
    if (verdict === 'silent') return
    if (verdict === 'error') return cb(new Error(`${op} failed`))
    cb(null, voidResult ? undefined : result)
  }
  return wrapper
}

const reset = (impl) => {
  calls = []
  behaviour = impl ?? (() => 'ok')
  openedChannels = []
}
sftp.registerSftpClientProvider(() => ({
  sftp: (cb) => {
    const w = makeWrapper()
    openedChannels.push(w)
    cb(null, w)
  }
}))

const expectReject = async (promise, label) => {
  try {
    await promise
    return { rejected: false, message: '' }
  } catch (err) {
    return { rejected: true, message: err instanceof Error ? err.message : String(err) }
  }
}

// ---- 1. a silent channel is bounded, not waited on forever -----------------
console.log('a silent (half-dead) channel rejects instead of hanging')
{
  reset(() => 'silent')
  sftp.closeSftp('s1')
  const started = Date.now()
  const r = await expectReject(sftp.listRemote('s1', '/home'), 'listRemote')
  const elapsed = Date.now() - started
  ok(r.rejected, 'listRemote rejects')
  ok(elapsed < 1500, `it rejected at the op budget, not later (${elapsed}ms)`)
  ok(r.message.length > 0, `the error carries a message for the user (${r.message})`)
  ok(!/^Failed/.test(r.message), 'the message is the app\'s own, not a raw ssh2 string')
}

{
  // The retry is the point: a timeout is TRANSPORT-classified, so the possibly
  // dead channel is evicted and the operation is retried once on a fresh one.
  reset(() => 'silent')
  sftp.closeSftp('s2')
  await expectReject(sftp.listRemote('s2', '/home'), 'listRemote')
  ok(
    openedChannels.length === 2,
    `a timeout evicts the channel and retries exactly once on a fresh one (${openedChannels.length} channels opened)`
  )
}

{
  // A second timeout on the retry must surface, not loop.
  let opened = 0
  reset(() => 'silent')
  sftp.registerSftpClientProvider(() => ({
    sftp: (cb) => {
      opened++
      const w = makeWrapper()
      openedChannels.push(w)
      cb(null, w)
    }
  }))
  sftp.closeSftp('s3')
  const r = await expectReject(sftp.listRemote('s3', '/home'), 'listRemote')
  ok(r.rejected, 'a second consecutive timeout still rejects (no retry loop)')
  ok(opened === 2, `exactly two channel opens for one operation (${opened})`)
  // Restore the shared provider for later sections.
  sftp.registerSftpClientProvider(() => ({
    sftp: (cb) => {
      const w = makeWrapper()
      openedChannels.push(w)
      cb(null, w)
    }
  }))
}

// ---- 2. metadata operations each have a bound ------------------------------
console.log('every metadata operation is bounded')
{
  const metadataOps = [
    ['listRemote', () => sftp.listRemote('m', '/home'), 'readdir'],
    ['mkdirRemote', () => sftp.mkdirRemote('m', '/home', 'dir'), 'mkdir'],
    ['renameRemote', () => sftp.renameRemote('m', '/a', '/b'), 'rename'],
    ['deleteRemote', () => sftp.deleteRemote('m', ['/a']), 'unlink']
  ]
  for (const [label, run, firstOp] of metadataOps) {
    reset((op) => (op === firstOp || (label === 'listRemote' && op === 'readdir') ? 'silent' : 'ok'))
    sftp.closeSftp('m')
    const started = Date.now()
    const r = await expectReject(run(), label)
    const elapsed = Date.now() - started
    ok(r.rejected, `${label} rejects on a silent channel`)
    ok(elapsed < 1500, `${label} rejected at the budget (${elapsed}ms)`)
  }
}

console.log('a server-side error is NOT retried (it means the channel is alive)')
{
  reset(() => 'error')
  sftp.closeSftp('alive')
  const r = await expectReject(sftp.listRemote('alive', '/home'), 'listRemote')
  ok(r.rejected, 'a server-side failure rejects')
  ok(openedChannels.length === 1, `an error reply does not evict the channel (${openedChannels.length} open, expected 1)`)
  ok(calls.filter((c) => c.op === 'readdir').length === 1, 'and the operation was not retried')
}

// ---- 3. the transfer budget is wider than the metadata one -----------------
console.log('a slow but progressing download is not killed by the metadata budget')
{
  const dir = mkdtempSync(join(root, 'dl-slow-'))
  // Each chunk answers after the metadata budget (60ms) but inside the transfer
  // budget (200ms): a slow link, not a dead one.
  reset((op) => (op === 'read' ? 'slow' : 'ok'))
  sftp.closeSftp('dl')
  const events = []
  await sftp.downloadRemote('dl', ['/remote/big.bin'], dir, (ch, payload) =>
    events.push(payload)
  )
  const done = await waitFor(() => events.some((e) => e.state === 'done' || e.state === 'error'), 3000)
  const final = events.at(-1)
  ok(done, 'the transfer settled')
  ok(final?.state === 'done', `a progressing transfer completes despite slow chunks (got '${final?.state}': ${final?.error ?? ''})`)
  rmSync(dir, { recursive: true, force: true })
}

console.log('a download whose channel goes silent IS bounded and reported')
{
  const dir = mkdtempSync(join(root, 'dl-dead-'))
  reset(() => 'silent')
  sftp.closeSftp('dl-dead')
  const events = []
  await sftp.downloadRemote('dl-dead', ['/remote/big.bin'], dir, (ch, payload) => events.push(payload))
  const settled = await waitFor(() => events.some((e) => e.state === 'error'), 3000)
  ok(settled, 'the transfer reported a terminal error instead of hanging')
  const err = events.find((e) => e.state === 'error')
  ok(typeof err?.error === 'string' && err.error.length > 0, `the error is user-visible (${err?.error})`)
  rmSync(dir, { recursive: true, force: true })
}

console.log('an upload whose channel goes silent IS bounded and reported')
{
  const dir = mkdtempSync(join(root, 'ul-dead-'))
  const src = join(dir, 'file.bin')
  writeFileSync(src, Buffer.alloc(600 * 1024, 0x42)) // >2 chunks, so writes happen
  reset((op) => (op === 'open' ? 'silent' : 'ok'))
  sftp.closeSftp('ul-dead')
  const events = []
  await sftp.uploadRemote('ul-dead', [src], '/remote', (ch, payload) => events.push(payload))
  const settled = await waitFor(() => events.some((e) => e.state === 'error'), 3000)
  ok(settled, 'the upload reported a terminal error')
  const err = events.find((e) => e.state === 'error')
  ok(typeof err?.error === 'string' && err.error.length > 0, `the error is user-visible (${err?.error})`)
  rmSync(dir, { recursive: true, force: true })
}

console.log('a silent write chunk (open succeeded) is bounded too')
{
  const dir = mkdtempSync(join(root, 'ul-silent-write-'))
  const src = join(dir, 'file.bin')
  writeFileSync(src, Buffer.alloc(600 * 1024, 0x42))
  reset((op) => (op === 'write' ? 'silent' : 'ok'))
  sftp.closeSftp('ul-silent-write')
  const events = []
  const started = Date.now()
  await sftp.uploadRemote('ul-silent-write', [src], '/remote', (ch, payload) => events.push(payload))
  const settled = await waitFor(() => events.some((e) => e.state === 'error'), 5000)
  const elapsed = Date.now() - started
  ok(settled, 'the upload reported a terminal error')
  ok(elapsed < 4000, `it gave up on the wider transfer budget rather than waiting forever (${elapsed}ms)`)
  rmSync(dir, { recursive: true, force: true })
}

// ---- 4. a late reply cannot resurrect an abandoned operation ---------------
console.log('a reply that arrives after the timeout is ignored, not applied')
{
  let late
  let settle
  reset(() => 'ok')
  sftp.registerSftpClientProvider(() => ({
    sftp: (cb) => {
      const w = makeWrapper()
      // readdir answers only when the test releases it — well after the timeout.
      w.readdir = (p, cb) => {
        calls.push({ op: 'readdir', args: [p] })
        late = () => cb(null, ['too-late.txt'])
      }
      openedChannels.push(w)
      cb(null, w)
    }
  }))
  sftp.closeSftp('late')
  const r = await expectReject(sftp.listRemote('late', '/home'), 'listRemote')
  ok(r.rejected, 'the operation timed out')
  ok(typeof late === 'function', 'the fake held the reply')
  let threw = false
  try {
    late() // the abandoned callback fires now
  } catch {
    threw = true
  }
  ok(!threw, 'releasing the late reply does not throw (the race is already settled)')
  await new Promise((r) => setTimeout(r, 20))
  ok(true, 'the process stayed alive after a late reply (no unhandled rejection)')
}

console.log('a rejection after the timeout is swallowed, not surfaced as a crash')
{
  let late
  reset(() => 'ok')
  sftp.registerSftpClientProvider(() => ({
    sftp: (cb) => {
      const w = makeWrapper()
      w.mkdir = (p, cb) => {
        calls.push({ op: 'mkdir', args: [p] })
        late = () => cb(new Error('too late'))
      }
      openedChannels.push(w)
      cb(null, w)
    }
  }))
  process.on('unhandledRejection', onUnhandled)
  let unhandled = 0
  function onUnhandled() {
    unhandled++
  }
  sftp.closeSftp('late2')
  await expectReject(sftp.mkdirRemote('late2', '/home', 'x'), 'mkdirRemote')
  late()
  await new Promise((r) => setTimeout(r, 30))
  process.off('unhandledRejection', onUnhandled)
  ok(unhandled === 0, `no unhandled rejection from the abandoned promise (${unhandled})`)
  // Restore the standard provider.
  sftp.registerSftpClientProvider(() => ({
    sftp: (cb) => {
      const w = makeWrapper()
      openedChannels.push(w)
      cb(null, w)
    }
  }))
}

// ---- 5. the subsystem open is bounded too ----------------------------------
console.log('a subsystem open that never answers is bounded (and retried once)')
{
  let opens = 0
  reset(() => 'ok')
  sftp.registerSftpClientProvider(() => ({
    // Never calls back: the half-dead client that accepts the request and dies.
    sftp: () => {
      opens++
    }
  }))
  sftp.closeSftp('open-dead')
  const started = Date.now()
  const r = await expectReject(sftp.listRemote('open-dead', '/home'), 'listRemote')
  const elapsed = Date.now() - started
  ok(r.rejected, 'the operation rejects')
  ok(opens === 2, `the dead open was retried exactly once (${opens} attempts)`)
  ok(elapsed < 1500, `bounded by the open budget (${elapsed}ms)`)
  sftp.registerSftpClientProvider(() => ({
    sftp: (cb) => {
      const w = makeWrapper()
      openedChannels.push(w)
      cb(null, w)
    }
  }))
}

console.log('a synchronous throw from client.sftp() is a rejection, not a crash')
{
  reset(() => 'ok')
  sftp.registerSftpClientProvider(() => ({
    sftp: () => {
      throw new Error('socket already gone')
    }
  }))
  sftp.closeSftp('sync-throw')
  const r = await expectReject(sftp.listRemote('sync-throw', '/home'), 'listRemote')
  ok(r.rejected, 'the synchronous throw became a rejection')
  sftp.registerSftpClientProvider(() => ({
    sftp: (cb) => {
      const w = makeWrapper()
      openedChannels.push(w)
      cb(null, w)
    }
  }))
}

console.log('a missing session is refused without opening anything')
{
  reset(() => 'ok')
  sftp.registerSftpClientProvider(() => undefined)
  sftp.closeSftp('gone')
  const r = await expectReject(sftp.listRemote('gone', '/home'), 'listRemote')
  ok(r.rejected, 'the operation rejects')
  ok(openedChannels.length === 0, 'no channel was opened for a missing session')
  sftp.registerSftpClientProvider(() => ({
    sftp: (cb) => {
      const w = makeWrapper()
      openedChannels.push(w)
      cb(null, w)
    }
  }))
}

// ---- 6. the budgets are the documented ones --------------------------------
console.log('default budgets are sane relative to each other')
{
  // The injected harness values are deliberately tiny; resetting them proves the
  // setter restores what later runs (and the app) expect, without depending on
  // internal constants.
  sftp.setSftpTimeouts({ op: 30_000, transfer: 60_000, open: 10_000 })
  reset(() => 'silent')
  sftp.closeSftp('budget')
  const started = Date.now()
  const probe = sftp.listRemote('budget', '/home')
  const settledEarly = await Promise.race([
    probe.then(() => true, () => true),
    new Promise((r) => setTimeout(() => r(false), 1500))
  ])
  ok(!settledEarly, 'with the production metadata budget, a 1.5s wait does not time out (the budget is generous, not hair-trigger)')
  // Don't wait out the real 30s: abandon it and restore the harness budget.
  void probe.catch(() => undefined)
  sftp.setSftpTimeouts({ op: 60, transfer: 200, open: 60 })
  const elapsed = Date.now() - started
  ok(elapsed < 3000, `the check itself was quick (${elapsed}ms)`)
}

// ---- helpers ----------------------------------------------------------------
function waitFor(pred, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now()
    const tick = () => {
      if (pred()) return resolve(true)
      if (Date.now() - started > timeoutMs) return resolve(false)
      setTimeout(tick, 10)
    }
    tick()
  })
}

rmSync(root, { recursive: true, force: true })

if (failed > 0) {
  console.error(`\n[sftp-timeout] ${failed} check(s) FAILED`)
  process.exit(1)
}
console.log(`\n[sftp-timeout] ALL CHECKS PASSED (${passed} assertions)`)
process.exit(0)
