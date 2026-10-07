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
 *
 * Build: node tests/build-bundles.cjs
 * Run:   node tests/updater-fallback.mjs   (must exit 0)
 */
import { mkdtempSync, rmSync } from 'node:fs'
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

const updater = require('./.updater.cjs')
const { Ipc } = require('./.ipc-channels.cjs')

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

  // configureAutoUpdater wires the event listeners and (unless the user turned
  // startup checks off) schedules a check 5s after launch — unref'd, so it does
  // not hold the test open.
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

stub.__setPackaged(false)
clearInterval(keepAlive)

if (failed > 0) {
  console.error(`\n[updater-fallback] ${failed} check(s) FAILED`)
  process.exit(1)
}
console.log(`\n[updater-fallback] ALL CHECKS PASSED (${passed} assertions)`)
