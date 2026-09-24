/**
 * Lock-controller self-test (lock-controller.mjs).
 *
 * Offline and Electron-free: every input the controller has — the two stores,
 * the settings, the clock, the idle time, the publisher — is injectable, so the
 * whole state machine runs under plain Node without a window or a real 15s poll.
 * Guards the contract the lock screen depends on:
 *   - the backoff ladder (1s / 2s / 5s / 10s / 30s, capped) and that an attempt
 *     inside the window is refused as `cooldown`, not answered as `wrong-password`
 *   - a success clears the failure count and the backoff with it
 *   - concurrent attempts are serialized, so firing two at once cannot step
 *     around the backoff (the regression this file exists for)
 *   - `locked` / `failures` / `cooldownUntil` survive a restart, and `start()`
 *     restores them silently (nothing is listening yet)
 *   - a stored lock without a verifier is discarded, never applied
 *   - a cooldown restored from the future is clamped (clock moved backwards)
 *   - idle auto-lock fires exactly once, and never on a broken or disabled input
 *   - clearing the password turns the preferences off and unlocks
 *   - lockNow()/unlock() are no-ops in the directions that would trap the user
 *
 * Build: node tests/build-bundles.cjs
 * Run:   node tests/lock-controller.mjs   (must exit 0)
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const dir = mkdtempSync(join(tmpdir(), 'ot-lockctl-'))

// The controller bundle re-exports only the controller; the stores come from the
// lock-store bundle, so the controller is tested against the real scrypt store
// rather than a hand-written double.
const { LockController } = require('./.lock-controller.cjs')
const { LockStore, LockStateStore, defaultLockStatePath } = require('./.lock-store.cjs')

let failed = 0
const ok = (cond, msg) => {
  console.log(`  ${cond ? 'ok' : 'FAIL'}: ${msg}`)
  if (!cond) failed++
}

const PASSWORD = 'correct horse'

/** Controllable clock: the whole ladder is driven without ever waiting on it. */
let clockMs = 1_700_000_000_000
const now = () => clockMs
const advance = (ms) => {
  clockMs += ms
}

/** Idle auto-lock off, so the real 15s poll `start()` installs is a no-op in
 *  every test that is not about idle time (no stray publish mid-assertion). */
const idleOff = () => ({ enabled: false, autoLockMinutes: 0, lockAtStartup: false })

let seq = 0
const freshStore = async () => {
  const store = new LockStore(join(dir, `lock-${seq++}.json`))
  await store.setPassword(PASSWORD)
  return store
}
const freshState = () => new LockStateStore(join(dir, `state-${seq++}.json`))

/** A controller with every input pinned; returns the publishes it produced. */
const makeController = (opts = {}) => {
  const publishes = []
  const controller = new LockController({
    store: opts.store,
    stateStore: opts.stateStore ?? freshState(),
    getLockSettings: opts.getLockSettings ?? idleOff,
    publish: (state) => publishes.push(state),
    now,
    idleSeconds: opts.idleSeconds ?? (() => 0),
    clearLockPreferences: opts.clearLockPreferences ?? (() => {})
  })
  return { controller, publishes }
}

/** A real store whose verify() takes a couple of turns of the event loop, so two
 *  attempts fired without awaiting genuinely overlap unless they are serialized. */
const slowStore = (store, delayMs = 20) => ({
  isConfigured: () => store.isConfigured(),
  setPassword: (password) => store.setPassword(password),
  clear: () => store.clear(),
  verify: async (password) => {
    await new Promise((resolve) => setTimeout(resolve, delayMs))
    return store.verify(password)
  }
})

// ---- 1. backoff ladder ------------------------------------------------------
console.log('[cooldown ladder]')
{
  const store = await freshStore()
  const stateStore = freshState()
  const { controller } = makeController({ store, stateStore })
  controller.lockNow()
  ok(controller.isLocked() === true, 'a configured lock can engage')

  const steps = [1000, 2000, 5000, 10000, 30000, 30000]
  for (let i = 0; i < steps.length; i++) {
    const attempt = await controller.unlock({ password: 'wrong' })
    ok(attempt.ok === false && attempt.error === 'wrong-password', `failure ${i + 1} reports wrong-password`)
    ok(attempt.state.cooldownMs === steps[i], `failure ${i + 1} backs off for ${steps[i]}ms`)
    ok(stateStore.load().failures === i + 1, `failure ${i + 1} is on disk`)

    // A second guess inside the window must be answered `cooldown`. Answering
    // `wrong-password` would mean the password was verified again, so a caller
    // could keep guessing (and keep escalating the ladder) with no waiting.
    const blocked = await controller.unlock({ password: 'wrong' })
    ok(blocked.ok === false && blocked.error === 'cooldown', `failure ${i + 1}: an immediate retry is refused as cooldown`)
    ok(blocked.state.cooldownMs === steps[i], `failure ${i + 1}: a refused retry does not restart the backoff`)
    ok(stateStore.load().failures === i + 1, `failure ${i + 1}: a refused retry is not counted as a failure`)

    // Advance by exactly the step: the remaining cooldown reaches 0, so the next
    // iteration is allowed through the gate again.
    advance(steps[i])
  }

  const opened = await controller.unlock({ password: PASSWORD })
  ok(opened.ok === true && opened.state.locked === false, 'the correct password still opens the screen after the full ladder')
}

// ---- 2. success clears the backoff ------------------------------------------
console.log('[success clears]')
{
  const store = await freshStore()
  const stateStore = freshState()
  const { controller } = makeController({ store, stateStore })
  controller.lockNow()
  const first = await controller.unlock({ password: 'wrong' })
  advance(first.state.cooldownMs)
  const second = await controller.unlock({ password: 'wrong' })
  ok(stateStore.load().failures === 2, 'two failures are recorded')
  advance(second.state.cooldownMs)

  const opened = await controller.unlock({ password: PASSWORD })
  ok(opened.ok === true, 'the correct password opens the screen')
  ok(opened.state.cooldownMs === undefined, 'a success reports no cooldown')
  ok(
    stateStore.load().failures === 0 && stateStore.load().cooldownUntil === 0,
    'a success clears the failure count and the backoff on disk'
  )

  // Indirect proof that the ladder really restarted: the next failure waits 1s,
  // which it could not do if the two earlier failures were still counted.
  controller.lockNow()
  const after = await controller.unlock({ password: 'wrong' })
  ok(after.state.cooldownMs === 1000, 'the failure after a success starts the ladder over at 1s')
}

// ---- 3. concurrent attempts are serialized ----------------------------------
console.log('[serialized attempts]')
{
  const store = await freshStore()
  const stateStore = freshState()
  const { controller } = makeController({ store: slowStore(store), stateStore })
  controller.lockNow()

  // Fired without awaiting: both calls are already inside the controller before
  // either verification resolves.
  const [first, second] = await Promise.all([
    controller.unlock({ password: 'wrong' }),
    controller.unlock({ password: 'wrong' })
  ])
  ok(first.error === 'wrong-password', 'the first of two concurrent attempts is verified and fails')
  ok(second.error === 'cooldown', 'the second is refused by the backoff the first just raised')
  ok(stateStore.load().failures === 1, 'two concurrent attempts count as one failure')

  advance(1000)
  const after = await controller.unlock({ password: PASSWORD })
  ok(after.ok === true, 'the correct password still works once the cooldown has passed')
}

// ---- 4. persistence round trip ----------------------------------------------
console.log('[persistence]')
{
  const lockFile = join(dir, 'lock-persist.json')
  const stateFile = join(dir, 'state-persist.json')
  const store = new LockStore(lockFile)
  await store.setPassword(PASSWORD)

  const first = makeController({ store, stateStore: new LockStateStore(stateFile) })
  first.controller.lockNow()
  ok(JSON.parse(readFileSync(stateFile, 'utf8')).locked === true, 'locking writes locked:true to the state file')

  // A relaunch is not a way out of a lock that was already up.
  const second = makeController({
    store: new LockStore(lockFile),
    stateStore: new LockStateStore(stateFile)
  })
  second.controller.start()
  ok(second.controller.isLocked() === true, 'a new instance over the same files starts locked')
  ok(second.publishes.length === 0, 'start() does not publish: nothing is listening yet')
  ok(JSON.parse(readFileSync(stateFile, 'utf8')).locked === true, 'and the restored lock is not written back as unlocked')

  const opened = await second.controller.unlock({ password: PASSWORD })
  ok(opened.ok === true && opened.state.locked === false, 'the correct password opens the restored lock')
  ok(JSON.parse(readFileSync(stateFile, 'utf8')).locked === false, 'unlocking writes locked:false to the state file')

  const third = makeController({
    store: new LockStore(lockFile),
    stateStore: new LockStateStore(stateFile)
  })
  third.controller.start()
  ok(third.controller.isLocked() === false, 'a fresh instance after an unlock does not lock')
}

// ---- 5. a stored lock with no verifier is discarded -------------------------
console.log('[start without a verifier]')
{
  const stateFile = join(dir, 'state-orphan.json')
  writeFileSync(stateFile, JSON.stringify({ version: 1, locked: true, failures: 2, cooldownUntil: 0 }), 'utf8')
  const { controller, publishes } = makeController({
    store: new LockStore(join(dir, 'lock-missing.json')),
    stateStore: new LockStateStore(stateFile)
  })
  controller.start()
  ok(existsSync(stateFile) === false, 'the stored flags are deleted: no password could ever open that lock again')
  ok(controller.isLocked() === false, 'and the screen is not locked')
  ok(publishes.length === 0, 'start() does not publish')
}

// ---- 6. a cooldown restored from the future is clamped ----------------------
console.log('[clock skew]')
{
  const store = await freshStore()
  const stateFile = join(dir, 'state-skew.json')
  writeFileSync(
    stateFile,
    JSON.stringify({ version: 1, locked: false, failures: 3, cooldownUntil: now() + 3_600_000 }),
    'utf8'
  )
  const { controller, publishes } = makeController({ store, stateStore: new LockStateStore(stateFile) })
  controller.start()
  ok(controller.getState().cooldownMs === 30000, 'an hour-long restored cooldown is clamped to the longest step')
  ok(publishes.length === 0, 'start() does not publish')

  // The restored failure count still drives the ladder: the 4th failure waits 10s.
  advance(30000)
  controller.lockNow()
  const attempt = await controller.unlock({ password: 'wrong' })
  ok(attempt.state.cooldownMs === 10000, 'the restored failure count still picks the matching step')
}
{
  const store = await freshStore()
  const stateFile = join(dir, 'state-keep.json')
  writeFileSync(
    stateFile,
    JSON.stringify({ version: 1, locked: false, failures: 0, cooldownUntil: now() + 5000 }),
    'utf8'
  )
  const { controller } = makeController({ store, stateStore: new LockStateStore(stateFile) })
  controller.start()
  ok(controller.getState().cooldownMs === 5000, 'a legitimately stored cooldown is kept exactly as it is')
}

// ---- 7. idle auto-lock ------------------------------------------------------
console.log('[idle auto-lock]')
{
  // checkIdle() is only `private` to TypeScript; the modifier is erased at
  // runtime, so the poll can be driven directly instead of waiting 15 seconds.
  const store = await freshStore()
  const enabled = () => ({ enabled: true, autoLockMinutes: 1, lockAtStartup: false })

  const idle = makeController({ store, getLockSettings: enabled, idleSeconds: () => 60 })
  idle.controller.checkIdle()
  ok(idle.controller.isLocked() === true, 'one minute of idleness locks the screen')
  ok(
    idle.publishes.length === 1 && idle.publishes[0].locked === true,
    'the lock is published once, so the overlay appears without being asked'
  )
  idle.controller.checkIdle()
  ok(idle.publishes.length === 1, 'a poll while already locked publishes nothing')
}
{
  const store = await freshStore()
  const enabled = () => ({ enabled: true, autoLockMinutes: 1, lockAtStartup: false })

  const justUnder = makeController({ store, getLockSettings: enabled, idleSeconds: () => 59 })
  justUnder.controller.checkIdle()
  ok(justUnder.controller.isLocked() === false, '59 seconds is not yet a minute of idleness')
  ok(justUnder.publishes.length === 0, 'and nothing is published')

  const disabled = makeController({
    store,
    getLockSettings: () => ({ ...enabled(), enabled: false }),
    idleSeconds: () => 3600
  })
  disabled.controller.checkIdle()
  ok(disabled.controller.isLocked() === false, 'the master switch off means idle never locks')

  const never = makeController({
    store,
    getLockSettings: () => ({ ...enabled(), autoLockMinutes: 0 }),
    idleSeconds: () => 3600
  })
  never.controller.checkIdle()
  ok(never.controller.isLocked() === false, 'autoLockMinutes 0 means never')
}
{
  const store = await freshStore()
  const broken = makeController({
    store,
    getLockSettings: () => ({ enabled: true, autoLockMinutes: 1, lockAtStartup: false }),
    idleSeconds: () => {
      throw new Error('powerMonitor is unavailable without a session')
    }
  })
  let threw = false
  try {
    broken.controller.checkIdle()
  } catch {
    threw = true
  }
  ok(!threw, 'a failing idle reading does not throw out of the poll')
  ok(broken.controller.isLocked() === false, 'and unknown idleness reads as not idle rather than locking the app')
}
{
  const unconfigured = makeController({
    store: new LockStore(join(dir, 'lock-noverifier-idle.json')),
    getLockSettings: () => ({ enabled: true, autoLockMinutes: 1, lockAtStartup: false }),
    idleSeconds: () => 3600
  })
  unconfigured.controller.checkIdle()
  ok(unconfigured.controller.isLocked() === false, 'an unconfigured lock never engages on idle')
}

// ---- 8. clearing the password -----------------------------------------------
console.log('[clear password]')
{
  const store = await freshStore()
  let cleared = 0
  const { controller } = makeController({ store, clearLockPreferences: () => void cleared++ })
  controller.lockNow()
  ok(controller.isLocked() === true, 'the screen is locked before clearing')

  const res = await controller.clearPassword({ currentPassword: PASSWORD })
  ok(res.ok === true, 'clearing with the correct password succeeds')
  ok(cleared === 1, 'the lock preferences are turned off exactly once')
  ok(controller.isLocked() === false, 'clearing also unlocks: an unconfigured lock can never be answered')
  ok(controller.getState().configured === false, 'the state reports unconfigured')
  ok(store.isConfigured() === false, 'the verifier file is gone')

  // Wrong current password: removing the lock must not be possible from the
  // keyboard alone, so nothing is cleared and the screen stays shut.
  await store.setPassword(PASSWORD)
  controller.lockNow()
  ok(controller.isLocked() === true, 'the screen locks again once a password exists')
  const bad = await controller.clearPassword({ currentPassword: 'wrong' })
  ok(bad.ok === false && bad.error === 'wrong-password', 'clearing with the wrong password is refused')
  ok(cleared === 1, 'and the preferences are left alone')
  ok(store.isConfigured() === true, 'and the password is still set')
  ok(controller.isLocked() === true, 'and the screen stays locked')
}

// ---- 9. the paths that must not trap the user -------------------------------
console.log('[unconfigured paths]')
{
  const { controller, publishes } = makeController({ store: new LockStore(join(dir, 'lock-none.json')) })
  const state = controller.lockNow()
  ok(state.locked === false && controller.isLocked() === false, 'lockNow() cannot lock without a verifier')
  ok(publishes.length === 0, 'and it publishes nothing')
}
{
  // Verifier deleted while running: nothing could ever open the screen again, so
  // it has to open rather than stay shut forever.
  const store = await freshStore()
  const { controller } = makeController({ store })
  controller.lockNow()
  ok(controller.isLocked() === true, 'a configured lock does engage')
  store.clear()
  const res = await controller.unlock({ password: 'anything' })
  ok(res.ok === true && controller.isLocked() === false, 'unlock() opens a screen whose verifier disappeared')
  ok(res.state.configured === false, 'and reports it as unconfigured')
}

// ---- 10. applyLocked is idempotent ------------------------------------------
console.log('[idempotent lock changes]')
{
  const store = await freshStore()
  const { controller, publishes } = makeController({
    store,
    getLockSettings: () => ({ enabled: true, autoLockMinutes: 1, lockAtStartup: false }),
    idleSeconds: () => 3600
  })
  controller.lockNow()
  ok(publishes.length === 1, 'the first lock publishes once')
  controller.lockNow()
  ok(publishes.length === 1, 'locking an already locked screen publishes nothing')
  controller.checkIdle()
  ok(publishes.length === 1, 'the idle watcher does not republish an existing lock')

  await controller.unlock({ password: PASSWORD })
  ok(publishes.length === 2, 'unlocking publishes once')
  await controller.unlock({ password: PASSWORD })
  ok(publishes.length === 2, 'unlocking an unlocked screen publishes nothing')

  store.clear()
  await controller.clearPassword({})
  ok(publishes.length === 2, 'clearing an unconfigured lock publishes nothing new')
  ok(controller.isLocked() === false, 'and leaves the screen unlocked')
}

// ---- 11. path helper --------------------------------------------------------
console.log('[paths]')
{
  const statePath = join(dir, 'lock-state.json')
  ok(
    resolve(defaultLockStatePath(dir)) === resolve(statePath),
    'defaultLockStatePath resolves to <userData>/lock-state.json'
  )
}

// The stores wrote into a temp dir; drop it so repeated runs do not litter %TEMP%.
rmSync(dir, { recursive: true, force: true })

console.log(failed === 0 ? '\n[lock-ctl] ALL CHECKS PASSED' : `\n[lock-ctl] ${failed} CHECK(S) FAILED`)
process.exit(failed === 0 ? 0 : 1)
