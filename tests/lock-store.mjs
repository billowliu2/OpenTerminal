/**
 * Lock-store self-test (lock-store.mjs).
 *
 * Offline and Electron-free: the store takes its file path by injection, so it
 * runs under plain Node. Guards the contract the lock controller relies on:
 *   - a fresh install is "not configured", and looking does not create a file
 *   - setting a password writes a scrypt verifier and never the password
 *   - correct / incorrect verification, case sensitivity, salt regenerated per write
 *   - the verifier survives a restart (a new store over the same file)
 *   - clearing removes the file and returns to "not configured"
 *   - missing / truncated / wrongly-shaped / wrongly-sized files read as
 *     unconfigured instead of throwing (a corrupt lock must not break startup)
 *   - the lock flags (locked / failures / cooldownUntil) round-trip through the
 *     state store, and every unusable shape of that file reads back as "unlocked
 *     with no failures" instead of throwing on the startup path
 *
 * Build: node tests/build-bundles.cjs
 * Run:   node tests/lock-store.mjs   (must exit 0)
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const dir = mkdtempSync(join(tmpdir(), 'ot-lock-'))
const lockFile = join(dir, 'lock.json')

const lock = require('./.lock-store.cjs')

let failed = 0
const ok = (cond, msg) => {
  console.log(`  ${cond ? 'ok' : 'FAIL'}: ${msg}`)
  if (!cond) failed++
}

const PASSWORD = 'correct horse'
const fresh = () => new lock.LockStore(lockFile)
const readRaw = () => readFileSync(lockFile, 'utf8')
/** Real base64 for the expected verifier sizes, so a damaged-file case can
 *  break exactly one field. */
const SALT16 = Buffer.alloc(16).toString('base64')
const HASH64 = Buffer.alloc(64).toString('base64')

// ---- 1. path helper ---------------------------------------------------------
console.log('[paths]')
// resolve() so the assertion holds whether the helper joins with '/' or '\'.
ok(resolve(lock.defaultLockPath(dir)) === resolve(lockFile), 'defaultLockPath resolves to <userData>/lock.json')

// ---- 2. unconfigured --------------------------------------------------------
console.log('[unconfigured]')
{
  const s = fresh()
  ok(s.isConfigured() === false, 'a missing file is not configured')
  ok((await s.verify(PASSWORD)) === false, 'verify() on an unconfigured store is false')
  ok(existsSync(lockFile) === false, 'verifying does not create the file')
}

// ---- 3. set + verify --------------------------------------------------------
console.log('[set + verify]')
{
  const s = fresh()
  await s.setPassword(PASSWORD)
  ok(s.isConfigured(), 'after setPassword the store is configured')
  ok(existsSync(lockFile), 'the verifier file exists')

  const raw = JSON.parse(readRaw())
  ok(raw.version === 1, 'stored version is 1')
  ok(typeof raw.salt === 'string' && typeof raw.hash === 'string', 'salt + hash are strings')
  ok(typeof raw.createdAt === 'number', 'createdAt is a number')
  ok(!readRaw().includes(PASSWORD), 'the password itself is not on disk')
  ok(!readRaw().includes('correct'), 'no fragment of the password is on disk')

  ok((await s.verify(PASSWORD)) === true, 'the correct password verifies')
  ok((await s.verify('correct hors')) === false, 'a near miss does not verify')
  ok((await s.verify('correct horse ')) === false, 'a trailing space does not verify')
  ok((await s.verify('')) === false, 'the empty string does not verify')
  ok((await s.verify('CORRECT HORSE')) === false, 'verification is case sensitive')
  ok(s.isConfigured(), 'a failed attempt does not unconfigure the store')
}
{
  // Replacing regenerates the salt, so the previous hash is worthless even when
  // the new password is the same one.
  const s = fresh()
  await s.setPassword(PASSWORD)
  const first = JSON.parse(readRaw())
  await s.setPassword(PASSWORD)
  const second = JSON.parse(readRaw())
  ok(first.salt !== second.salt, 'each write generates a fresh salt')
  ok(first.hash !== second.hash, 'and therefore a different hash')
  ok((await s.verify(PASSWORD)) === true, 'the replaced verifier still matches the same password')
}

// ---- 4. persistence round trip ----------------------------------------------
console.log('[persistence]')
{
  const s = fresh()
  await s.setPassword(PASSWORD)
  const reopened = new lock.LockStore(lockFile) // "restart"
  ok(reopened.isConfigured(), 'a new store over the same file is configured')
  ok((await reopened.verify(PASSWORD)) === true, 'the password survives a restart')
  ok((await reopened.verify('nope')) === false, 'a wrong password still fails after a restart')
}

// ---- 5. password length policy ----------------------------------------------
console.log('[length policy]')
{
  ok(lock.isValidPassword('abcd') === true, '4 characters is accepted')
  ok(lock.isValidPassword('a'.repeat(128)) === true, '128 characters is accepted')
  ok(lock.isValidPassword('abc') === false, '3 characters is refused')
  ok(lock.isValidPassword('') === false, 'the empty password is refused')
  ok(lock.isValidPassword('a'.repeat(129)) === false, '129 characters is refused')
  ok(lock.isValidPassword(undefined) === false, 'a missing password is refused')
  ok(lock.isValidPassword(1234) === false, 'a non-string password is refused')
}
{
  const path = join(dir, 'unset.json')
  const s = new lock.LockStore(path)
  let threw = false
  try {
    await s.setPassword('abc')
  } catch {
    threw = true
  }
  ok(threw, 'setPassword refuses a too-short password')
  threw = false
  try {
    await s.setPassword('')
  } catch {
    threw = true
  }
  ok(threw, 'setPassword refuses an empty password')
  ok(s.isConfigured() === false, 'a refused password leaves the store unconfigured')
  ok(existsSync(path) === false, 'nothing was written for a refused password')
}

// ---- 6. clear ---------------------------------------------------------------
console.log('[clear]')
{
  const s = fresh()
  await s.setPassword(PASSWORD)
  s.clear()
  ok(s.isConfigured() === false, 'clearing returns the store to unconfigured')
  ok(existsSync(lockFile) === false, 'clearing removes the file')
  ok((await s.verify(PASSWORD)) === false, 'a cleared store verifies nothing')
}
{
  let threw = false
  try {
    fresh().clear()
  } catch {
    threw = true
  }
  ok(!threw, 'clearing an unconfigured store does not throw')
}

// ---- 7. damaged files -------------------------------------------------------
console.log('[damaged files]')
const damaged = [
  ['truncated JSON', '{"version":1,"salt":"AAAA"'],
  ['an empty file', ''],
  ['JSON null', 'null'],
  ['a JSON array', '[]'],
  ['a bare string', '"nope"'],
  ['an unknown version', JSON.stringify({ version: 2, salt: SALT16, hash: HASH64, createdAt: 1 })],
  ['a missing hash', JSON.stringify({ version: 1, salt: SALT16, createdAt: 1 })],
  ['a non-string salt', JSON.stringify({ version: 1, salt: 42, hash: HASH64, createdAt: 1 })],
  [
    'a salt of the wrong size',
    JSON.stringify({ version: 1, salt: Buffer.alloc(8).toString('base64'), hash: HASH64, createdAt: 1 })
  ],
  ['a hash of the wrong size', JSON.stringify({ version: 1, salt: SALT16, hash: 'AAAA', createdAt: 1 })],
  ['a missing createdAt', JSON.stringify({ version: 1, salt: SALT16, hash: HASH64 })]
]
for (const [name, content] of damaged) {
  writeFileSync(lockFile, content, 'utf8')
  const s = fresh()
  let threw = false
  let configured = true
  let verified = true
  try {
    configured = s.isConfigured()
    verified = await s.verify(PASSWORD)
  } catch {
    threw = true
  }
  ok(
    !threw && configured === false && verified === false,
    `${name} reads as unconfigured without throwing`
  )
}
{
  // A directory at the store path (EISDIR) is unreadable, not "a password is set".
  const asDir = join(dir, 'as-dir')
  mkdirSync(asDir, { recursive: true })
  const s = new lock.LockStore(asDir)
  let threw = false
  let configured = true
  try {
    configured = s.isConfigured()
  } catch {
    threw = true
  }
  ok(!threw && configured === false, 'a directory at the store path reads as unconfigured')
}
{
  // Recovery: a corrupt file is overwritten by the next set, not left blocking.
  writeFileSync(lockFile, 'not json at all', 'utf8')
  const s = fresh()
  await s.setPassword(PASSWORD)
  ok(s.isConfigured() === true && (await s.verify(PASSWORD)) === true, 'a corrupt file can be replaced')
}

// ---- 8. lock state store ----------------------------------------------------
console.log('[lock state store]')
const stateFile = join(dir, 'lock-state.json')
const stateStore = () => new lock.LockStateStore(stateFile)
{
  ok(
    resolve(lock.defaultLockStatePath(dir)) === resolve(stateFile),
    'defaultLockStatePath resolves to <userData>/lock-state.json'
  )

  const s = stateStore()
  ok(s.load().locked === false, 'a missing state file reads as unlocked')
  ok(existsSync(stateFile) === false, 'and reading it does not create the file')
}
{
  // The controller writes every flag change through; a lost round trip would hand
  // back an unlocked app (or a reset backoff) after a restart.
  const s = stateStore()
  s.save({ locked: true, failures: 2, cooldownUntil: 1234 })
  const raw = JSON.parse(readFileSync(stateFile, 'utf8'))
  ok(raw.version === 1, 'the state file records version 1')
  const loaded = s.load()
  ok(
    loaded.locked === true && loaded.failures === 2 && loaded.cooldownUntil === 1234,
    'load() returns exactly what save() wrote'
  )
  ok(new lock.LockStateStore(stateFile).load().failures === 2, 'the flags survive a restart (a new store over the same file)')
}
{
  const s = stateStore()
  s.save({ locked: true, failures: 1, cooldownUntil: 5000 })
  s.clear()
  ok(existsSync(stateFile) === false, 'clear() removes the state file')
  ok(s.load().locked === false, 'and the flags read back as unlocked')
  let threw = false
  try {
    s.clear()
  } catch {
    threw = true
  }
  ok(!threw, 'clearing an absent state file does not throw')
}
{
  // Every one of these must land on the same fallback: the load runs on the
  // startup path, where throwing would leave the app without a window while it
  // still holds the single-instance lock.
  const fallback = (state) =>
    state.locked === false && state.failures === 0 && state.cooldownUntil === 0
  const damagedStates = [
    ['an empty file', ''],
    ['truncated JSON', '{"version":1,"locked":true'],
    ['JSON null', 'null'],
    ['a JSON array', '[]'],
    ['a bare string', '"locked"'],
    ['an unknown version', JSON.stringify({ version: 2, locked: true, failures: 3, cooldownUntil: 9 })],
    ['a missing version', JSON.stringify({ locked: true, failures: 3, cooldownUntil: 9 })],
    ['a non-boolean locked', JSON.stringify({ version: 1, locked: 'true', failures: 0, cooldownUntil: 0 })],
    ['locked: 1', JSON.stringify({ version: 1, locked: 1, failures: 0, cooldownUntil: 0 })],
    ['a fractional failure count', JSON.stringify({ version: 1, locked: false, failures: 2.5, cooldownUntil: 0 })],
    ['a negative failure count', JSON.stringify({ version: 1, locked: false, failures: -1, cooldownUntil: 0 })],
    ['a stringified failure count', JSON.stringify({ version: 1, locked: false, failures: '2', cooldownUntil: 0 })],
    ['a missing failure count', JSON.stringify({ version: 1, locked: false, cooldownUntil: 0 })],
    // JSON has no NaN and no Infinity: both arrive as null, or as text that is
    // not JSON at all. Either way the cooldown must not become a live deadline.
    ['a nulled cooldown', JSON.stringify({ version: 1, locked: false, failures: 0, cooldownUntil: null })],
    ['a literal NaN cooldown', '{"version":1,"locked":false,"failures":0,"cooldownUntil":NaN}'],
    ['a literal Infinity cooldown', '{"version":1,"locked":false,"failures":0,"cooldownUntil":Infinity}'],
    ['a stringified cooldown', JSON.stringify({ version: 1, locked: false, failures: 0, cooldownUntil: '1234' })],
    ['a negative cooldown', JSON.stringify({ version: 1, locked: false, failures: 0, cooldownUntil: -5000 })]
  ]
  for (const [name, content] of damagedStates) {
    writeFileSync(stateFile, content, 'utf8')
    let threw = false
    let state = null
    try {
      state = stateStore().load()
    } catch {
      threw = true
    }
    ok(!threw && fallback(state), `${name} reads as unlocked with no failures, without throwing`)
  }
}
{
  // A damaged file must not block the next save (the controller writes after
  // every change, so it has to be able to recover on its own).
  writeFileSync(stateFile, 'not json at all', 'utf8')
  const s = stateStore()
  s.save({ locked: true, failures: 0, cooldownUntil: 0 })
  ok(s.load().locked === true, 'a damaged state file can be replaced')
}

// The stores wrote into a temp dir; drop it so repeated runs do not litter %TEMP%.
rmSync(dir, { recursive: true, force: true })

console.log(failed === 0 ? '\n[lock] ALL CHECKS PASSED' : `\n[lock] ${failed} CHECK(S) FAILED`)
process.exit(failed === 0 ? 0 : 1)
