/**
 * Update-service self-test (updater-fallback.mjs).
 *
 * src/main/updater.ts owns the two-feed strategy that keeps update checks
 * working for users behind (and without) a proxy. Everything in it that used to
 * be untestable — electron-updater and electron's session/net — is stubbed:
 *
 *   - `electron-updater` is aliased to tests/electron-updater-stub.cjs, driven
 *     through `globalThis.__otAutoUpdater`
 *   - electron's `session.fromPartition(...).fetch` goes through
 *     `globalThis.__otFetch`, and each session records its `setProxy` calls
 *
 * What is pinned here:
 *   - the GitHub probe gates the feed: reachable -> GitHub first; unreachable
 *     (thrown, non-OK, or TIMED OUT) -> straight to Gitea, and the updater is
 *     never pointed at GitHub
 *   - the probe timeout really fires (a fetch that never resolves is abandoned
 *     at the budget, not waited on)
 *   - a check that throws on GitHub falls back to Gitea, and BOTH error
 *     messages reach the user when Gitea fails too
 *   - the overall check budget rejects a check that never settles, and the
 *     state lands on 'error' — never stuck on 'checking'
 *   - the feed choice is per attempt: a transient GitHub failure does not pin
 *     the next check to Gitea
 *   - proxy modes: Gitea forces `direct`, GitHub uses `system` (the whole point
 *     of the two-feed split)
 *   - dev builds never check (state 'dev'), and a packaged build's changelog
 *     fetch falls back through the three sources
 *   - the schedule: the periodic timer follows the configured interval, 0 means
 *     never, re-applying replaces the cadence, and the startup check is armed at
 *     most once per run (sections 10-13)
 *   - one check at a time (a second caller shares the in-flight promise), and the
 *     `scheduled` / `auto` marks belong to the caller that started it
 *   - one release is fetched and announced once: a repeating cycle does not
 *     restart the download, does not repeat the balloon, and does not downgrade a
 *     finished download back to 'available'; a different release is news again,
 *     and a manual check is never suppressed
 *   - balloons respect their guards (Windows only, tray present, no visible
 *     window)
 *
 * Build: node tests/build-bundles.cjs
 * Run:   node tests/updater-fallback.mjs   (must exit 0)
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

// ---- stub control -----------------------------------------------------------
// Must be installed BEFORE the bundle is required (the stub reads globals).
const ctl = {
  checkForUpdates: undefined,
  downloadUpdate: undefined,
  quitAndInstallCalls: [],
  feeds: [],
  proxies: []
}
globalThis.__otAutoUpdater = ctl

let fetchImpl = undefined
globalThis.__otFetch = (url, init) => {
  if (!fetchImpl) {
    return Promise.resolve({ ok: false, status: 404, text: async () => '', json: async () => [] })
  }
  return fetchImpl(url, init)
}

const stub = require('./electron-stub.cjs')
stub.__setPackaged(false)

/**
 * Load the bundle with its inlined tray slot exposed, and hand the test's own
 * `Tray` stub to it.
 *
 * Why this is needed: `src/main/tray.ts` keeps the tray in a module-level slot
 * that only `initTray()` fills, and `initTray` is not something updater.ts
 * imports — esbuild drops it, so the bundle has no way to create a tray at all
 * and `notifyUpdate` (the sole balloon producer, and what the balloon assertions
 * are about) always returns at its `!tray` guard. The bundle text is therefore
 * re-emitted with ONE appended line that reads/writes that slot, and that copy —
 * byte-identical otherwise — is the module under test. Nothing under src/ is
 * touched, and `require('./.updater.cjs')` is still what is exercised, just via a
 * copy built from the freshly compiled file.
 *
 * `slot` stays undefined if a future build renames or drops the slot; the
 * balloon checks then skip (with a printed reason) rather than fail.
 */
let bundleTmpDir
const requireUpdater = () => {
  const source = readFileSync(join(__dirname, '.updater.cjs'), 'utf8')
  if (!/^var tray = null;$/m.test(source)) return { module: require('./.updater.cjs'), slot: undefined }
  const dir = mkdtempSync(join(tmpdir(), 'ot-updater-bundle-'))
  bundleTmpDir = dir
  const patched = join(dir, 'updater.cjs')
  writeFileSync(
    patched,
    `${source}
// harness: expose the inlined tray slot (see tests/updater-fallback.mjs)
module.exports.__traySlot = { get: () => tray, set: (value) => { tray = value } }
`,
    'utf8'
  )
  return { module: require(patched), slot: require(patched).__traySlot }
}

const { module: updater, slot: traySlot } = requireUpdater()
const { Ipc } = require('./.ipc-channels.cjs')

/** Stand a tray up exactly as `initTray` would, using the stub's own class. */
if (traySlot) traySlot.set(new stub.Tray({}))

let failed = 0
let passed = 0
const ok = (cond, msg) => {
  console.log(`  ${cond ? 'ok' : 'FAIL'}: ${msg}`)
  if (!cond) failed += 1
  else passed += 1
}

// Shrink every budget so timeout paths run in milliseconds, not minutes.
updater.setUpdateTimeouts({ probe: 60, check: 120, fetch: 60 })

/**
 * The service's own timers (`withTimeout`, `AbortSignal.timeout`) are unref'd on
 * purpose — a pending update check must never keep the app alive. In a test
 * process that means Node can decide to exit while an awaited check is still
 * pending, which shows up as "unsettled top-level await". This ref'd interval
 * keeps the loop turning for the duration of the run.
 */
const keepAlive = setInterval(() => {}, 1000)

// The channels are registered by registerUpdateIpc(); the stub records them.
updater.registerUpdateIpc()
const handlers = stub.__handlers
const call = (channel, ...args) => handlers.get(channel)({ senderFrame: { url: 'x' } }, ...args)

// The module-level `state` is shared by every section below, so the birth state
// is asserted here — before any check has had a chance to move it.
const birthState = await call(Ipc.UPDATE_STATE_GET)

const reset = () => {
  ctl.feeds.length = 0
  ctl.proxies.length = 0
  ctl.quitAndInstallCalls.length = 0
  ctl.checkForUpdates = undefined
  fetchImpl = undefined
  stub.__sessions.clear()
}
const okResponse = (body = '') => ({
  ok: true,
  status: 200,
  text: async () => body,
  json: async () => JSON.parse(body || '[]')
})
const errResponse = (status = 500) => ({
  ok: false,
  status,
  text: async () => '',
  json: async () => []
})
/**
 * A fetch that never settles on its own — the half-dead channel the timeouts
 * exist for. It holds the event loop open with a ref'd timer because
 * `AbortSignal.timeout`'s internal timer is unref'd: without it Node would exit
 * before the abort fires and the test would look like a hang.
 */
const neverSettles = (url, init) =>
  new Promise((_, reject) => {
    const keepAlive = setTimeout(() => reject(new Error('harness: fetch never settled')), 30_000)
    init?.signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(keepAlive)
        reject(new Error('aborted'))
      },
      { once: true }
    )
  })

const GitHubProbeHost = 'api.github.com'
const isProbe = (url) => String(url).includes(GitHubProbeHost)
let probeCalls = 0
const feedFor = (provider, feeds) => feeds.find((f) => f.provider === provider)
const lastFeed = () => ctl.feeds[ctl.feeds.length - 1]
/**
 * Which feed the updater was last pointed at, in the terms the service uses:
 * electron-updater's provider name is 'github' for the GitHub feed and
 * 'generic' for the domestic Gitea package channel.
 */
const lastFeedName = () => (lastFeed()?.provider === 'github' ? 'github' : 'gitea')
const proxyFor = (name) => stub.__sessions.get(name)?.proxyCalls ?? []

// ---- 1. initial state + dev build ------------------------------------------
console.log('a freshly started service')
{
  ok(birthState.status === 'idle', `the service starts idle (got '${birthState.status}')`)
  ok(birthState.currentVersion === '0.0.0-stub', 'the state always carries the running version')
  ok(birthState.version === undefined, 'no version is claimed before a check')
  ok(birthState.error === undefined, 'no error is claimed before a check')
  ok(birthState.percent === undefined, 'no download percent before a download')
}

console.log('dev build (not packaged)')
{
  reset()
  stub.__setPackaged(false)
  let checked = false
  ctl.checkForUpdates = async () => {
    checked = true
    return null
  }
  const state = await call(Ipc.UPDATE_CHECK)
  ok(state.status === 'dev', `a dev build reports 'dev' (got '${state.status}')`)
  ok(!checked, 'the updater is never asked to check in a dev build')
  ok(ctl.feeds.length === 0, 'no feed is configured in a dev build')
  await call(Ipc.UPDATE_DOWNLOAD)
  ok(true, 'download in a dev build is a no-op, not a crash')
}

// ---- 2. probe reachable -> GitHub first ------------------------------------
console.log('probe succeeds: GitHub is the feed')
{
  reset()
  stub.__setPackaged(true)
  probeCalls = 0
  fetchImpl = (url) => {
    if (isProbe(url)) {
      probeCalls++
      return Promise.resolve(okResponse('{"tag_name":"v1"}'))
    }
    return Promise.resolve(okResponse('[]'))
  }
  let seen = ''
  ctl.checkForUpdates = async () => {
    seen = lastFeedName()
    return null
  }
  const state = await call(Ipc.UPDATE_CHECK)
  ok(probeCalls === 1, 'the probe ran exactly once')
  ok(seen === 'github', `the check ran against the GitHub feed (got '${seen}')`)
  ok(feedFor('github', ctl.feeds) !== undefined, 'the GitHub feed was configured')
  ok(feedFor('github', ctl.feeds).owner === 'billowliu2', 'the GitHub feed carries the repo owner')
  ok(proxyFor('openterminal-github-probe').some((p) => p.mode === 'system'), 'the probe used the system proxy')
  ok(state.status === 'checking' || state.status === 'error' || state.status === 'idle', `state is a known value (${state.status})`)
}

// ---- 3. probe fails -> straight to Gitea -----------------------------------
console.log('probe failures fall through to Gitea without touching GitHub')
const probeFailures = [
  ['non-OK response (404 from a blocked/mirrored host)', () => Promise.resolve(errResponse(404))],
  ['a thrown network error', () => Promise.reject(new Error('ENOTFOUND api.github.com'))],
  ['a fetch that never settles (times out at the budget)', neverSettles]
]
for (const [label, impl] of probeFailures) {
  reset()
  stub.__setPackaged(true)
  probeCalls = 0
  fetchImpl = (url, init) => {
    if (isProbe(url)) {
      probeCalls++
      return impl(url, init)
    }
    return Promise.resolve(okResponse('[]'))
  }
  let seen = ''
  ctl.checkForUpdates = async () => {
    seen = lastFeedName()
    return null
  }
  const started = Date.now()
  await call(Ipc.UPDATE_CHECK)
  const elapsed = Date.now() - started
  ok(probeCalls === 1, `${label}: the probe was attempted once`)
  ok(seen === 'gitea', `${label}: the check went straight to Gitea (got '${seen}')`)
  ok(feedFor('github', ctl.feeds) === undefined, `${label}: the GitHub feed was never configured`)
  ok(feedFor('generic', ctl.feeds) !== undefined, `${label}: the Gitea feed is the generic provider`)
  if (label.includes('times out')) {
    ok(elapsed < 2000, `${label}: the abandoned probe was refused at the budget, not waited on (${elapsed}ms)`)
  } else {
    ok(elapsed < 2000, `${label}: resolved promptly (${elapsed}ms)`)
  }
}

console.log('proxy modes: Gitea is forced direct, GitHub uses the system proxy')
{
  reset()
  stub.__setPackaged(true)
  fetchImpl = (url) => (isProbe(url) ? Promise.resolve(okResponse('{}')) : Promise.resolve(okResponse('[]')))
  ctl.checkForUpdates = async () => {
    // netSession.setProxy is what useFeed() calls on the updater itself.
    return null
  }
  await call(Ipc.UPDATE_CHECK)
  ok(
    ctl.proxies.some((p) => p.mode === 'system'),
    'the GitHub attempt set the updater session to the system proxy'
  )

  reset()
  fetchImpl = () => Promise.resolve(errResponse(503))
  ctl.checkForUpdates = async () => null
  await call(Ipc.UPDATE_CHECK)
  ok(
    ctl.proxies.some((p) => p.mode === 'direct'),
    'the Gitea attempt set the updater session to direct (a system proxy breaks it)'
  )
}

// ---- 4. GitHub check fails -> Gitea fallback, both errors reported ---------
console.log('a GitHub check failure falls back to Gitea')
{
  reset()
  stub.__setPackaged(true)
  fetchImpl = (url) => (isProbe(url) ? Promise.resolve(okResponse('{}')) : Promise.resolve(okResponse('[]')))
  const attempted = []
  ctl.checkForUpdates = async () => {
    attempted.push(lastFeedName())
    if (attempted.length === 1) throw new Error('github exploded')
    return null
  }
  const state = await call(Ipc.UPDATE_CHECK)
  ok(attempted.join(',') === 'github,gitea', `both feeds were tried in order (${attempted.join(',')})`)
  ok(feedFor('generic', ctl.feeds) !== undefined, 'the Gitea feed was configured for the fallback')
  ok(state.status !== 'error', `the fallback succeeded, so no error state (got '${state.status}')`)
}

console.log('both feeds failing reports BOTH reasons to the user')
{
  reset()
  stub.__setPackaged(true)
  fetchImpl = (url) => (isProbe(url) ? Promise.resolve(okResponse('{}')) : Promise.resolve(okResponse('[]')))
  const attempted = []
  ctl.checkForUpdates = async () => {
    attempted.push(lastFeedName())
    throw new Error(attempted.length === 1 ? 'github exploded' : 'gitea exploded')
  }
  const state = await call(Ipc.UPDATE_CHECK)
  ok(attempted.join(',') === 'github,gitea', 'both feeds were attempted')
  ok(state.status === 'error', `the state is 'error' (got '${state.status}')`)
  ok(typeof state.error === 'string' && state.error.includes('github exploded'), 'the GitHub reason is reported')
  ok(typeof state.error === 'string' && state.error.includes('gitea exploded'), 'the Gitea reason is reported')
}

console.log('Gitea-only failure reports its own reason')
{
  reset()
  stub.__setPackaged(true)
  fetchImpl = () => Promise.resolve(errResponse(503))
  ctl.checkForUpdates = async () => {
    throw new Error('gitea exploded')
  }
  const state = await call(Ipc.UPDATE_CHECK)
  ok(state.status === 'error', 'the state is error')
  ok(state.error === 'gitea exploded', `the Gitea reason is the error (got ${JSON.stringify(state.error)})`)
}

// ---- 5. the overall check budget -------------------------------------------
console.log('a check that never settles is bounded by the overall budget')
{
  reset()
  stub.__setPackaged(true)
  fetchImpl = () => Promise.resolve(errResponse(503)) // probe fails -> Gitea directly
  ctl.checkForUpdates = () => new Promise(() => {}) // never settles
  const started = Date.now()
  const state = await call(Ipc.UPDATE_CHECK)
  const elapsed = Date.now() - started
  ok(elapsed < 3000, `it gave up at the budget instead of hanging (${elapsed}ms)`)
  ok(state.status === 'error', `the state is 'error', never stuck on 'checking' (got '${state.status}')`)
  ok(typeof state.error === 'string' && state.error.length > 0, 'an error message is set for the UI')
}

console.log('a GitHub check that never settles still lands on an error, not on "checking"')
{
  reset()
  stub.__setPackaged(true)
  fetchImpl = (url) => (isProbe(url) ? Promise.resolve(okResponse('{}')) : Promise.resolve(okResponse('[]')))
  // The probe succeeds, so the first (GitHub) attempt is the one that hangs.
  // electron-updater de-dupes concurrent checks, so the Gitea fallback shares
  // the abandoned promise — it must still be bounded, not left hanging.
  let calls = 0
  ctl.checkForUpdates = () => {
    calls++
    return new Promise(() => {})
  }
  const state = await call(Ipc.UPDATE_CHECK)
  ok(calls === 2, `both attempts ran against the same in-flight promise (${calls})`)
  ok(state.status === 'error', `the state resolved to 'error' (got '${state.status}')`)
}

// ---- 6. the feed choice is per attempt -------------------------------------
console.log('the feed choice is not pinned by a transient failure')
{
  reset()
  stub.__setPackaged(true)
  let probeFails = false
  fetchImpl = (url) =>
    isProbe(url)
      ? Promise.resolve(probeFails ? errResponse(500) : okResponse('{}'))
      : Promise.resolve(okResponse('[]'))
  const attempts = []
  ctl.checkForUpdates = async () => {
    attempts.push(lastFeedName())
    return null
  }

  await call(Ipc.UPDATE_CHECK)
  ok(attempts.at(-1) === 'github', 'the first check used GitHub')

  probeFails = true
  await call(Ipc.UPDATE_CHECK)
  ok(attempts.at(-1) === 'gitea', 'with the probe now failing, the next check uses Gitea')

  probeFails = false
  await call(Ipc.UPDATE_CHECK)
  ok(attempts.at(-1) === 'github', 'once the probe recovers the next check goes back to GitHub (no pinning)')
}

// ---- 7. event wiring + state -------------------------------------------------
console.log('updater events drive the state the renderer reads')
{
  reset()
  const userData = mkdtempSync(join(tmpdir(), 'ot-updater-'))
  stub.__setUserData(userData)
  stub.__setPackaged(true)

  // configureAutoUpdater wires the event listeners. It arms NO timer: the startup
  // check and the periodic one belong to applyUpdateSchedule, which
  // settingsStore's injected applier calls on startup and on every settings save.
  updater.configureAutoUpdater()

  // `on()` publishes the instance the bundle actually subscribed, which is NOT
  // the one this file required (the bundle inlines its own copy of the stub).
  const live = ctl.live
  ok(live !== undefined, 'configureAutoUpdater wired the updater events')
  ok(live.logger === console, 'the updater logs through console')
  ok(live.autoDownload === false, 'auto-download is left to the user (the UI offers the button)')
  ok(live.autoInstallOnAppQuit === true, 'a downloaded update installs on app quit')

  const before = await call(Ipc.UPDATE_STATE_GET)
  ok(before !== undefined && typeof before.currentVersion === 'string', 'UPDATE_STATE_GET returns the current state')
  ok(before.currentVersion === '0.0.0-stub', 'the state always carries the running version')
  // `feed` is only reported alongside an availability: it names the feed the
  // check that FOUND the update used, and there is nothing to name before one.
  ok(before.feed === undefined, 'no feed is named before an update is found')
  ok(
    ctl.feeds.at(-1)?.provider === 'generic',
    'a packaged launch configures the domestic feed first (the safe default)'
  )

  live.emit('checking-for-update')
  {
    const s = await call(Ipc.UPDATE_STATE_GET)
    ok(s.status === 'checking', "'checking-for-update' sets the checking state")
    ok(s.error === undefined, 'the previous error is cleared when a new check starts')
  }

  live.emit('update-available', { version: '9.9.9' })
  {
    const s = await call(Ipc.UPDATE_STATE_GET)
    ok(s.status === 'available' && s.version === '9.9.9', `'update-available' carries the version (got ${JSON.stringify(s)})`)
    ok(s.feed === 'gitea', "the state names the feed the check actually used")
    ok(s.percent === undefined, 'the percent is cleared for a fresh availability')
  }

  live.emit('download-progress', { percent: 42.7 })
  ok((await call(Ipc.UPDATE_STATE_GET)).percent === 43, 'the download percent is rounded for the UI')

  live.emit('update-downloaded', { version: '9.9.9' })
  {
    const s = await call(Ipc.UPDATE_STATE_GET)
    ok(s.status === 'downloaded', "'update-downloaded' sets the downloaded state")
    ok(s.percent === undefined, 'the percent is cleared once downloaded')
  }

  live.emit('update-not-available')
  ok((await call(Ipc.UPDATE_STATE_GET)).status === 'latest', "'update-not-available' sets the latest state")

  live.emit('error', new Error('boom'))
  {
    const s = await call(Ipc.UPDATE_STATE_GET)
    ok(s.status === 'error' && s.error === 'boom', "the updater's 'error' event reaches the state")
  }

  // A non-Error rejection still has to produce a readable message.
  live.emit('error', 'a string reason')
  ok((await call(Ipc.UPDATE_STATE_GET)).error === 'a string reason', 'a non-Error error value is stringified')

  rmSync(userData, { recursive: true, force: true })
  stub.__setUserData('')
}

// ---- 8. changelog sources ---------------------------------------------------
console.log('changelog: the update channel wins, then the releases APIs')
{
  reset()
  stub.__setPackaged(true)
  fetchImpl = (url) => {
    const u = String(url)
    if (u.endsWith('release-notes.md')) return Promise.resolve(okResponse('# v9 notes\nline two'))
    if (u.endsWith('latest.yml')) return Promise.resolve(okResponse("version: 9.9.9\nreleaseDate: '2026-01-02T03:04:05Z'\n"))
    return Promise.resolve(errResponse(404))
  }
  const notes = await call(Ipc.UPDATE_CHANGELOG)
  ok(Array.isArray(notes) && notes.length === 1, `the channel's release-notes.md is used (${notes.length} entry)`)
  ok(notes[0].version === 'v9.9.9', `the version comes from latest.yml (got '${notes[0].version}')`)
  ok(notes[0].date === '2026-01-02', `the date is truncated to the day (got '${notes[0].date}')`)
  ok(notes[0].body.includes('# v9 notes'), 'the body is the release-notes.md text')
}

console.log('changelog: an empty/stalled channel falls through to the releases API')
{
  reset()
  stub.__setPackaged(true)
  const releases = JSON.stringify([
    { tag_name: 'v2.0.0', published_at: '2026-02-03T00:00:00Z', body: 'notes 2' },
    { tag_name: 'v1.9.0', published_at: '2026-01-04T00:00:00Z', body: 'notes 1' },
    { name: 'named-entry', published_at: '2026-01-05T00:00:00Z', body: 'named' },
    { published_at: '2026-01-06T00:00:00Z', body: 'dropped: no version at all' }
  ])
  fetchImpl = (url) => {
    const u = String(url)
    if (u.endsWith('release-notes.md')) return Promise.resolve(okResponse('')) // empty -> fall through
    if (u.endsWith('latest.yml')) return Promise.resolve(errResponse(404))
    if (u.includes('git.codingplan.site') && u.includes('releases')) return Promise.resolve(errResponse(404))
    if (u.includes('api.github.com') && u.includes('releases')) return Promise.resolve(okResponse(releases))
    return Promise.resolve(errResponse(404))
  }
  const notes = await call(Ipc.UPDATE_CHANGELOG)
  ok(notes.length === 3, `entries without any version are dropped (${notes.length} kept)`)
  ok(notes[0].version === 'v2.0.0' && notes[0].date === '2026-02-03', 'the newest release is first')
  ok(notes.some((n) => n.version === 'named-entry'), 'a release with only a name falls back to it')
  ok(notes.every((n) => n.version !== ''), 'every returned entry has a version')
}

console.log('changelog: every source failing yields an empty list, not a rejection')
{
  reset()
  stub.__setPackaged(true)
  fetchImpl = () => Promise.reject(new Error('offline'))
  const notes = await call(Ipc.UPDATE_CHANGELOG)
  ok(Array.isArray(notes) && notes.length === 0, 'the About tab gets [] instead of a thrown error')
}

console.log('changelog: a stalled channel is abandoned at the fetch budget')
{
  reset()
  stub.__setPackaged(true)
  let aborted = 0
  fetchImpl = (url, init) => {
    aborted++
    return neverSettles(url, init)
  }
  const started = Date.now()
  const notes = await call(Ipc.UPDATE_CHANGELOG)
  const elapsed = Date.now() - started
  ok(Array.isArray(notes) && notes.length === 0, 'the stalled channel produced no notes')
  ok(elapsed < 3000, `it gave up at the budget (${elapsed}ms, ${aborted} fetch attempts)`)
}

// ---- 9. install -------------------------------------------------------------
console.log('install')
{
  reset()
  stub.__setPackaged(true)
  await call(Ipc.UPDATE_INSTALL)
  ok(ctl.quitAndInstallCalls.length === 1, 'a packaged build calls quitAndInstall once')
  ok(ctl.quitAndInstallCalls[0][1] === true, 'and asks for a relaunch (isForceRunAfter)')

  reset()
  stub.__setPackaged(false)
  await call(Ipc.UPDATE_INSTALL)
  ok(ctl.quitAndInstallCalls.length === 0, 'a dev build does not call quitAndInstall')
}

// ---- 10. the schedule, auto-download, suppression, balloons ------------------
/**
 * Everything below shares module-level state that no test can reset, so the
 * scenarios are chosen around it:
 *  - the suppression record (src/main/updater.ts `ActedRelease`) holds ONE
 *    release at a time, is dropped by a manual check and is replaced wholesale
 *    when a different version shows up — so each scenario uses its own version
 *    number (7.x and 9.9.9 are spent by section 7), or starts from a manual check;
 *  - the "startup check armed" flag is per run too: the first `applyUpdateSchedule`
 *    that allows startup checks is the only one that can arm it, which is why
 *    sections 10-13 run in this order.
 * `reset()` re-points the feeds and the check/download doubles, so those do not
 * leak between sections.
 */
const scheduleDir = mkdtempSync(join(tmpdir(), 'ot-updater-schedule-'))
stub.__setUserData(scheduleDir)
/** The settings the update handlers read (autoDownloadUpdate lives here). */
const writeSystem = (system) => writeFileSync(join(scheduleDir, 'settings.json'), JSON.stringify({ system }))
/** Every check the harness observed, with the source mark published for it. */
const checkLog = []
const recordCheck = () => {
  // Read synchronously: the handler returns the module state, and the mark is
  // written before the check is handed to the updater.
  checkLog.push(call(Ipc.UPDATE_STATE_GET).scheduled === true)
  return Promise.resolve(null)
}
const startupChecks = () => checkLog.filter((scheduled) => scheduled === false).length
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
/** Let a listener the module started with `void` settle. */
const tick = () => sleep(5)

/**
 * A window fake rich enough for the two things the bundled code does with
 * `BrowserWindow.getAllWindows()`: `broadcast` sends the new state to each window,
 * and `notifyUpdate` asks the first one whether it is visible.
 */
const fakeWindow = (visible) => ({
  isVisible: () => visible,
  isDestroyed: () => false,
  webContents: { send: () => {} }
})

/** Windows-only side effect, and it needs a tray the bundle cannot create itself. */
const balloons = () => (globalThis.__otBalloons ??= [])
const balloonCount = () => balloons().length
const balloonChecksWork = process.platform === 'win32' && traySlot !== undefined
const whyNoBalloons =
  traySlot === undefined ? 'the bundle exposes no tray slot' : `process.platform is ${process.platform}`
const okBalloon = (cond, msg) => {
  if (!balloonChecksWork) {
    console.log(`  skip: ${msg} (${whyNoBalloons})`)
    return
  }
  ok(cond, msg)
}

// The events were wired by section 7; the call is idempotent. `live` is the
// instance the bundle subscribed — emitting on any other one is a no-op.
updater.configureAutoUpdater()
const live = ctl.live
ok(live !== undefined, 'the updater instance under test is the one the bundle wired')

console.log('the periodic check follows the configured interval')
{
  reset()
  stub.__setPackaged(true)
  updater.setUpdateTimeouts({ hour: 5, startupDelay: 20 }) // one "hour" = 5ms
  // Startup checks off here on purpose: this section counts the periodic ticks,
  // and the timer that arms the startup one is the subject of the next section.
  writeSystem({ autoCheckUpdate: false, updateCheckIntervalHours: 4, autoDownloadUpdate: false })
  ctl.checkForUpdates = recordCheck
  fetchImpl = () => Promise.resolve(errResponse(503)) // probe fails -> one attempt per check

  const from = checkLog.length
  updater.applyUpdateSchedule({ autoCheckUpdate: false, updateCheckIntervalHours: 4 })
  await sleep(200)
  const ticks = checkLog.slice(from)
  ok(ticks.length >= 2, `a 4-hour interval ticks repeatedly (${ticks.length} checks in 200ms)`)
  ok(
    ticks.every((scheduled) => scheduled === true),
    'every one of them is marked as a scheduled check'
  )
  ok(startupChecks() === 0, 'and none of them was mistaken for the startup check')
}

console.log('interval 0: the periodic check is off, the startup check still runs once')
{
  reset()
  stub.__setPackaged(true)
  updater.setUpdateTimeouts({ startupDelay: 20, hour: 5 })
  writeSystem({ autoCheckUpdate: true, updateCheckIntervalHours: 0, autoDownloadUpdate: false })
  ctl.checkForUpdates = recordCheck
  fetchImpl = () => Promise.resolve(errResponse(503))

  const from = checkLog.length
  updater.applyUpdateSchedule({ autoCheckUpdate: true, updateCheckIntervalHours: 0 })
  await sleep(150)
  const ran = checkLog.slice(from)
  ok(ran.length === 1, `exactly one check ran — the startup one (${ran.length})`)
  ok(ran[0] === false, "'never' means the startup check is the only one, and it is not marked scheduled")
  ok(startupChecks() === 1, 'the run has seen its startup check exactly once')
}

console.log('re-applying the schedule replaces the cadence (and 0 stops it)')
{
  reset()
  stub.__setPackaged(true)
  updater.setUpdateTimeouts({ startupDelay: 20, hour: 5 })
  writeSystem({ autoCheckUpdate: true, updateCheckIntervalHours: 24, autoDownloadUpdate: false })
  ctl.checkForUpdates = recordCheck
  fetchImpl = () => Promise.resolve(errResponse(503))

  const from = checkLog.length
  updater.applyUpdateSchedule({ autoCheckUpdate: true, updateCheckIntervalHours: 24 }) // one hour = 5ms -> 120ms
  await sleep(150)
  const slow = checkLog.slice(from)
  ok(slow.length <= 2, `a 24-hour interval is slow (${slow.length} checks in 150ms)`)

  const fastFrom = checkLog.length
  updater.applyUpdateSchedule({ autoCheckUpdate: true, updateCheckIntervalHours: 4 }) // -> 20ms
  await sleep(150)
  const fast = checkLog.slice(fastFrom)
  ok(fast.length >= 3, `switching to 4 hours speeds the beat up (${fast.length} checks in 150ms)`)
  ok(fast.length > slow.length, 'the new cadence replaced the old one')

  // Back to the slow interval: if the 20ms timer had merely been left running, it
  // would keep ticking ~7 times here instead of at most once.
  updater.applyUpdateSchedule({ autoCheckUpdate: true, updateCheckIntervalHours: 24 })
  await sleep(30)
  const settled = checkLog.length
  await sleep(150)
  ok(
    checkLog.length - settled <= 1,
    `the 20ms timer is gone, only the slow beat is left (${checkLog.length - settled} checks)`
  )

  updater.applyUpdateSchedule({ autoCheckUpdate: true, updateCheckIntervalHours: 0 })
  const stopped = checkLog.length
  await sleep(150)
  ok(checkLog.length === stopped, `switching to 0 stops the timer (${checkLog.length - stopped} checks after)`)
}

console.log('the startup check is armed at most once per run')
{
  reset()
  stub.__setPackaged(true)
  updater.setUpdateTimeouts({ startupDelay: 15, hour: 5 })
  writeSystem({ autoCheckUpdate: true, updateCheckIntervalHours: 0, autoDownloadUpdate: false })
  ctl.checkForUpdates = recordCheck
  fetchImpl = () => Promise.resolve(errResponse(503))

  // A settings save re-runs this applier, so three more applications stand in for
  // three saves two seconds into the run: none of them may add a startup check on
  // top of the one the previous section saw.
  const before = checkLog.length
  updater.applyUpdateSchedule({ autoCheckUpdate: true, updateCheckIntervalHours: 0 })
  updater.applyUpdateSchedule({ autoCheckUpdate: true, updateCheckIntervalHours: 0 })
  updater.applyUpdateSchedule({ autoCheckUpdate: true, updateCheckIntervalHours: 0 })
  await sleep(150)
  ok(checkLog.length === before, `repeated applies scheduled no extra check (${checkLog.length - before})`)
  ok(startupChecks() === 1, 'and the whole run still has exactly one startup check')
}

console.log('a check already running is shared, never started twice')
{
  reset()
  stub.__setPackaged(true)
  writeSystem({ autoCheckUpdate: true, updateCheckIntervalHours: 0, autoDownloadUpdate: false })
  fetchImpl = () => Promise.resolve(errResponse(503))
  let calls = 0
  let settle
  ctl.checkForUpdates = () => {
    calls++
    return new Promise((resolve) => {
      settle = resolve
    })
  }

  const manual = updater.runCheck('manual')
  const scheduled = updater.runCheck('scheduled')
  ok(manual === scheduled, 'the second caller gets the very same promise')
  // The updater is only called after the GitHub probe resolves, so give the
  // started check a turn before counting.
  await tick()
  ok(calls === 1, `the updater was asked to check once (${calls})`)
  ok(call(Ipc.UPDATE_STATE_GET).scheduled === false, 'the mark belongs to the check that actually started (manual)')

  settle(null)
  const [a, b] = await Promise.all([manual, scheduled])
  ok(a === b, 'both callers resolve to the same state')
  ok(calls === 1, `still one upstream check after it settled (${calls})`)
}

console.log('auto-download follows the setting')
{
  reset()
  stub.__setPackaged(true)
  writeSystem({ autoCheckUpdate: true, updateCheckIntervalHours: 0, autoDownloadUpdate: true })
  let downloads = 0
  ctl.downloadUpdate = () => {
    downloads++
    return Promise.resolve()
  }

  live.emit('update-available', { version: '8.8.8' })
  await tick()
  {
    const s = call(Ipc.UPDATE_STATE_GET)
    ok(downloads === 1, `the transfer starts on its own (${downloads})`)
    ok(s.status === 'downloading', `the state moves to 'downloading' (got '${s.status}')`)
    ok(s.version === '8.8.8', 'the downloading state names the version')
    ok(s.auto === true, 'and is marked automatic (the About tab keys its wording off this)')
  }

  writeSystem({ autoCheckUpdate: true, updateCheckIntervalHours: 0, autoDownloadUpdate: false })
  live.emit('update-available', { version: '8.8.7' })
  await tick()
  {
    const s = call(Ipc.UPDATE_STATE_GET)
    ok(downloads === 1, `with the setting off nothing is fetched (${downloads})`)
    ok(s.status === 'available', `the state stays 'available' for the UI button (got '${s.status}')`)
  }
}

console.log('the same release is fetched and announced once')
{
  reset()
  stub.__setPackaged(true)
  writeSystem({ autoCheckUpdate: true, updateCheckIntervalHours: 0, autoDownloadUpdate: true })
  let downloads = 0
  ctl.downloadUpdate = () => {
    downloads++
    return Promise.resolve()
  }
  const base = balloonCount()
  /** One 4-hour cycle reporting the same release again. */
  const cycle = (version) => {
    live.emit('checking-for-update')
    live.emit('update-available', { version })
  }

  cycle('7.7.7')
  await tick()
  live.emit('download-progress', { percent: 50 })
  live.emit('update-downloaded', { version: '7.7.7' })
  await tick()
  ok(downloads === 1, `one fetch for one release (${downloads})`)
  okBalloon(balloonCount() === base + 1, `the finished download is announced once (${balloonCount() - base})`)

  const announced = balloonCount()
  cycle('7.7.7')
  await tick()
  ok(downloads === 1, `the next cycle does not restart the transfer (${downloads})`)
  okBalloon(balloonCount() === announced, `and does not repeat the balloon (${balloonCount() - announced} more)`)

  // Auto-download off: now the availability balloon is the one that must not repeat.
  writeSystem({ autoCheckUpdate: true, updateCheckIntervalHours: 0, autoDownloadUpdate: false })
  const quiet = balloonCount()
  cycle('7.7.6')
  await tick()
  const s = call(Ipc.UPDATE_STATE_GET)
  ok(s.status === 'available' && s.version === '7.7.6', `the release is still reported to the UI (${s.status})`)
  okBalloon(balloonCount() === quiet + 1, `a fresh release is announced once (${balloonCount() - quiet})`)
  const told = balloonCount()
  cycle('7.7.6')
  await tick()
  okBalloon(balloonCount() === told, `the same release is not announced again (${balloonCount() - told} more)`)
  ok(downloads === 1, 'and nothing was fetched behind the user (the setting is off)')
}

console.log('a different release is news again')
{
  reset()
  stub.__setPackaged(true)
  writeSystem({ autoCheckUpdate: true, updateCheckIntervalHours: 0, autoDownloadUpdate: true })
  let downloads = 0
  ctl.downloadUpdate = () => {
    downloads++
    return Promise.resolve()
  }
  const base = balloonCount()

  live.emit('update-available', { version: '6.6.6' })
  await tick()
  live.emit('update-downloaded', { version: '6.6.6' })
  await tick()
  ok(downloads === 1, `the first release is fetched (${downloads})`)
  okBalloon(balloonCount() === base + 1, `and announced once (${balloonCount() - base})`)

  live.emit('update-available', { version: '6.6.5' })
  await tick()
  ok(downloads === 2, `a new release is fetched as if the app had just started (${downloads})`)
  live.emit('update-downloaded', { version: '6.6.5' })
  await tick()
  okBalloon(balloonCount() === base + 2, `and announced once of its own (${balloonCount() - base})`)
}

console.log('a manual check is never suppressed')
{
  reset()
  stub.__setPackaged(true)
  writeSystem({ autoCheckUpdate: true, updateCheckIntervalHours: 0, autoDownloadUpdate: false })
  fetchImpl = () => Promise.resolve(errResponse(503))
  const base = balloonCount()
  ctl.checkForUpdates = () => {
    live.emit('update-available', { version: '5.5.5' })
    return Promise.resolve(null)
  }

  // A background cycle announces the release the first time…
  await updater.runCheck('scheduled')
  ok(call(Ipc.UPDATE_STATE_GET).status === 'available', 'a background check reports the release')
  const first = balloonCount()
  okBalloon(first === base + 1, `and announces it (${first - base})`)

  // …and stays quiet about it afterwards — that is the suppression.
  await updater.runCheck('scheduled')
  okBalloon(balloonCount() === first, 'a later background check for the same release stays quiet')

  // A click on "check now" is an explicit act: the record is dropped, so the same
  // release is reported and announced again.
  const state = await call(Ipc.UPDATE_CHECK)
  ok(state.status === 'available' && state.version === '5.5.5', `the manual check reports it again (${state.status})`)
  okBalloon(balloonCount() === first + 1, `and announces it again (${balloonCount() - first})`)
}

console.log('a finished download stays finished')
{
  reset()
  stub.__setPackaged(true)
  writeSystem({ autoCheckUpdate: true, updateCheckIntervalHours: 0, autoDownloadUpdate: true })
  let downloads = 0
  ctl.downloadUpdate = () => {
    downloads++
    return Promise.resolve()
  }
  const version = '4.4.4'

  live.emit('update-available', { version })
  await tick()
  {
    const s = call(Ipc.UPDATE_STATE_GET)
    ok(s.status === 'downloading' && downloads === 1, `the automatic download started (${s.status}, ${downloads})`)
    ok(s.auto === true, 'marked automatic')
  }
  live.emit('update-downloaded', { version })
  await tick()
  {
    const s = call(Ipc.UPDATE_STATE_GET)
    ok(s.status === 'downloaded', `the package is on disk (got '${s.status}')`)
    ok(s.percent === undefined, 'the progress bar is cleared')
    ok(s.auto === true, 'the automatic mark survives (the panel keys its wording off it)')
  }

  // The 4-hour cycle reports the same release again: the UI must not fold "install"
  // back into "download" — and must not be parked on a spinner either.
  live.emit('checking-for-update')
  ok(call(Ipc.UPDATE_STATE_GET).status === 'checking', 'the cycle starts by reporting a check in progress')
  live.emit('update-available', { version })
  {
    const s = call(Ipc.UPDATE_STATE_GET)
    ok(s.status === 'downloaded', `the finished download is not downgraded to 'available' (got '${s.status}')`)
    ok(s.status !== 'checking', 'and the state is not left on the spinner')
    ok(s.version === version, `the state still names the release (${s.version})`)
    ok(s.percent === undefined, 'with no leftover percent')
    ok(s.auto === true, 'and the automatic mark intact')
  }
  ok(downloads === 1, `the repeat cycle fetched nothing (${downloads})`)

  // `downloaded` is not `fetchHandled`: a transfer that only started must not be
  // mistaken for a finished one.
  live.emit('update-available', { version: '4.4.3' })
  await tick()
  ok(downloads === 2, `a new release is fetched (${downloads})`)
  live.emit('download-progress', { percent: 10 })
  ok(call(Ipc.UPDATE_STATE_GET).status === 'downloading', 'the transfer is in progress')
  live.emit('update-available', { version: '4.4.3' })
  {
    const s = call(Ipc.UPDATE_STATE_GET)
    ok(s.status !== 'downloaded', `a started-but-unfinished transfer is not 'downloaded' (got '${s.status}')`)
    ok(downloads === 2, `and the fetched-once claim keeps the second cycle from restarting it (${downloads})`)
  }

  // Failures and "nothing to report" cycles must not forget what is on disk.
  live.emit('update-downloaded', { version: '4.4.3' })
  await tick()
  ok(call(Ipc.UPDATE_STATE_GET).status === 'downloaded', 'the second release finishes too')
  live.emit('error', new Error('boom'))
  ok(call(Ipc.UPDATE_STATE_GET).status === 'error', 'an error is reported as usual')
  live.emit('update-available', { version: '4.4.3' })
  ok(
    call(Ipc.UPDATE_STATE_GET).status === 'downloaded',
    'but the finished package is still known after the error'
  )
  live.emit('update-not-available')
  ok(call(Ipc.UPDATE_STATE_GET).status === 'latest', "'nothing to update' is reported as usual")
  live.emit('update-available', { version: '4.4.3' })
  ok(
    call(Ipc.UPDATE_STATE_GET).status === 'downloaded',
    'and still survives a cycle that found nothing'
  )

  // A NEW release replaces the record instead of inheriting it.
  writeSystem({ autoCheckUpdate: true, updateCheckIntervalHours: 0, autoDownloadUpdate: false })
  live.emit('update-available', { version: '4.4.2' })
  {
    const s = call(Ipc.UPDATE_STATE_GET)
    ok(s.status === 'available', `a different release starts from 'available' (got '${s.status}')`)
    ok(s.version === '4.4.2', `and is named (${s.version})`)
  }
}

console.log('balloons respect the visible-window guard')
{
  reset()
  stub.__setPackaged(true)
  writeSystem({ autoCheckUpdate: true, updateCheckIntervalHours: 0, autoDownloadUpdate: false })
  if (!balloonChecksWork) {
    console.log(`  skip: the balloon guard checks (${whyNoBalloons})`)
  } else {
    stub.__setWindows([fakeWindow(true)])
    const visible = balloonCount()
    live.emit('update-available', { version: '3.3.3' })
    ok(balloonCount() === visible, 'a visible window suppresses the balloon (the About tab already shows the state)')

    stub.__setWindows([fakeWindow(false)])
    const hidden = balloonCount()
    live.emit('update-available', { version: '3.3.2' })
    ok(balloonCount() === hidden + 1, 'with every window hidden the balloon is shown')

    stub.__setWindows([])
    const closed = balloonCount()
    live.emit('update-available', { version: '3.3.1' })
    ok(balloonCount() === closed + 1, 'and it is shown when no window has been created at all')
  }
}

stub.__setWindows([])
stub.__setUserData('')
rmSync(scheduleDir, { recursive: true, force: true })
if (bundleTmpDir) {
  try {
    rmSync(bundleTmpDir, { recursive: true, force: true })
  } catch {
    // best effort: the copy only has to live as long as the run needs the module
  }
}

stub.__setPackaged(false)
clearInterval(keepAlive)

if (failed > 0) {
  console.error(`\n[updater-fallback] ${failed} check(s) FAILED`)
  process.exit(1)
}
console.log(`\n[updater-fallback] ALL CHECKS PASSED (${passed} assertions)`)
