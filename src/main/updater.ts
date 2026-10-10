import { app, ipcMain, net, session } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { SystemSettings, UpdateCheckInterval } from '@shared/settings'
import { isUpdateCheckInterval } from '@shared/settings'
import { Ipc, type ReleaseNote, type UpdateState } from '../shared/ipc'
import { t } from '../shared/i18n'
import { broadcast } from './broadcast'
import { devUpdateFeedUrl } from './devEnv'
import { loadSettings } from './settingsStore'
import { markQuitting, notifyUpdate } from './tray'

/**
 * Update feeds: GitHub releases is tried first (system proxy, gated by a
 * 20s connectivity probe so proxy-less users don't hang); the domestic
 * Gitea generic package is the fallback (forced direct). Both feeds carry
 * the NSIS .exe — electron-updater does NOT support MSI auto-updates, MSI
 * is manual only.
 */
const GITEA_FEED =
  'https://git.codingplan.site/api/packages/admin/generic/openterminal-update/stable/'
const GITEA_RELEASES_API =
  'https://git.codingplan.site/api/v1/repos/admin/OpenTerminal/releases?limit=10'
const GITHUB_REPO = { owner: 'billowliu2', repo: 'OpenTerminal' }
const GITHUB_RELEASES_API =
  'https://api.github.com/repos/billowliu2/OpenTerminal/releases?per_page=10'
const GITHUB_PROBE_URL =
  'https://api.github.com/repos/billowliu2/OpenTerminal/releases/latest'

/**
 * Time budgets, kept in one mutable object so the offline harness
 * (tests/updater-fallback.mjs) can drive the timeout and fallback paths without
 * waiting out the production values. Nothing in the app calls
 * `setUpdateTimeouts`; the numbers below are the shipping ones.
 *
 *  - `probe`: GitHub connectivity probe. Short enough that a proxy-less user
 *    falls back to Gitea instead of hanging on a dead proxy/DNS.
 *  - `check`: overall budget for ONE check attempt — see withTimeout, which
 *    exists because electron-updater's own socket idle timeout only fires on
 *    silence, so a slow trickling response can hold an attempt open forever.
 *  - `fetch`: changelog / releases-API fetches; a stalled response must not
 *    hang the About tab.
 *  - `startupDelay`: how long after launch the startup check runs.
 *  - `hour`: what one settings "hour" is worth in milliseconds. The periodic
 *    check multiplies the configured interval (4/12/24) by it, so the harness can
 *    drive a whole cadence in milliseconds instead of waiting out real hours.
 */
const budgets = {
  probe: 20_000,
  check: 30_000,
  fetch: 15_000,
  startupDelay: 5_000,
  hour: 3_600_000
}

export function setUpdateTimeouts(patch: Partial<typeof budgets>): void {
  Object.assign(budgets, patch)
}

/** Interval used when settings carry no whitelisted value (a hand-built object). */
const FALLBACK_CHECK_INTERVAL_HOURS: UpdateCheckInterval = 4

/** Which entry point asked for a check; surfaced as `UpdateState.scheduled`. */
export type CheckSource = 'manual' | 'startup' | 'scheduled'
/** Which entry point asked for a download; surfaced as `UpdateState.auto`. */
type DownloadSource = 'manual' | 'auto'

let state: UpdateState = { status: 'idle', currentVersion: app.getVersion() }
let activeFeed: 'gitea' | 'github' = 'gitea'
let eventsWired = false
/**
 * In-flight check / download. Both electron-updater calls de-dupe concurrent
 * callers internally by handing back the same promise, which would make the
 * second caller silently inherit the first one's source marks — guarding here
 * keeps `scheduled` / `auto` honest, and keeps a background tick from hijacking
 * a check the user just started by hand.
 */
let checkInFlight: Promise<UpdateState> | undefined
let downloadInFlight: Promise<void> | undefined
/** The periodic check timer; reassigned on every settings save. */
let intervalTimer: NodeJS.Timeout | undefined
/** Once per run: the startup check is armed the first time the schedule is
 *  applied, and a later settings save must not schedule a second one. */
let startupArmed = false

/**
 * What has already been done for ONE release, so an app left running for days
 * does not deal with the same version over and over: every 4 hours the periodic
 * check re-reports the same availability, and without this record each cycle
 * walked electron-updater through another `downloadUpdate()` — its cache makes
 * that cheap, but the "update downloaded" balloon fired again every time — or,
 * with auto-download off, repeated the "an update is available" balloon.
 *
 * One record at a time, deliberately: suppression is about the release the last
 * check reported, and any DIFFERENT version replaces the whole record. A new
 * release must be announced and downloaded as if this were a fresh launch, so
 * the record must not outlive the release it describes (which also means a feed
 * flapping between two versions cannot leave the older one suppressed, and that
 * the memory here is bounded by construction).
 */
type ActedRelease = {
  version: string
  /** The "an update is available" balloon was already considered for this version. */
  announced: boolean
  /** A download of this version has been started (and not failed) or already
   *  finished — no later cycle needs that transfer again. Says nothing about
   *  whether the transfer ENDED: it is set when a download starts. */
  fetchHandled: boolean
  /** The package for this version is on disk (`update-downloaded` was seen).
   *  Separate from `fetchHandled` on purpose — a download in flight must not be
   *  mistaken for a finished one, or `downloading` would be skipped over. */
  downloaded: boolean
  /** The "the update has been downloaded" balloon was already considered. */
  downloadedAnnounced: boolean
}
let actedRelease: ActedRelease | undefined

/** The record for `version`, replaced wholesale when it names a different release. */
function actedFor(version: string): ActedRelease {
  if (actedRelease === undefined || actedRelease.version !== version) {
    actedRelease = {
      version,
      announced: false,
      fetchHandled: false,
      downloaded: false,
      downloadedAnnounced: false
    }
  }
  return actedRelease
}

function setState(patch: Partial<UpdateState>): void {
  state = { ...state, ...patch, currentVersion: app.getVersion() }
  broadcast(Ipc.UPDATE_STATE, state)
}

function useFeed(feed: 'gitea' | 'github'): void {
  activeFeed = feed
  if (feed === 'gitea') {
    // Domestic feed: always direct — a system proxy only breaks it.
    // OT_UPDATE_URL overrides the feed in dev builds only; OT_UPDATE_TOKEN is
    // read from the environment in every build, which is only safe because the
    // packaged URL is the hardcoded GITEA_FEED — making it configurable again
    // would turn the token into a credential sent to whatever host it names.
    void autoUpdater.netSession.setProxy({ mode: 'direct' })
    const token = process.env.OT_UPDATE_TOKEN
    autoUpdater.setFeedURL({
      provider: 'generic',
      url: devUpdateFeedUrl() ?? GITEA_FEED,
      ...(token ? { requestHeaders: { Authorization: `token ${token}` } } : {})
    })
  } else {
    // GitHub usually needs the system proxy (when one is enabled).
    void autoUpdater.netSession.setProxy({ mode: 'system' })
    autoUpdater.setFeedURL({ provider: 'github', ...GITHUB_REPO })
  }
}

function wireEvents(): void {
  if (eventsWired) return
  eventsWired = true
  autoUpdater.on('checking-for-update', () => setState({ status: 'checking', error: undefined }))
  autoUpdater.on('update-available', (info) => {
    const seen = actedFor(info.version)
    // A release whose package already sits on disk keeps the `downloaded` state.
    // Reporting `available` again would fold the About tab's "install" button back
    // into "download" — for a user who never installed, every 4-hour cycle, for
    // as long as the app stays open. The record is dropped before a manual check
    // looks at it, so a hand-started check reports the truth again.
    //
    // The state cannot simply be left alone here: the check that found this
    // release put it on 'checking', so an early return with no write would park
    // the About tab on a spinner forever. Rebuild the equivalent 'downloaded'
    // state instead — same fields `update-downloaded` writes, and `setState`
    // merges, so `auto` (which the About tab reads for the automatic wording) and
    // `scheduled` survive untouched.
    if (seen.downloaded) {
      setState({ status: 'downloaded', version: info.version, feed: activeFeed, percent: undefined })
      return
    }
    setState({ status: 'available', version: info.version, feed: activeFeed, percent: undefined })
    // The write above reports what the check just found; the suppression below is
    // about what has already been done for that release, so a 4-hour cycle that
    // keeps finding the same one does not restart its download or repeat its
    // balloon. (A release that already finished downloading never gets here — it
    // was answered above.)
    // With auto-download on there is no "an update is available" balloon: the
    // balloon that matters is the one saying the download finished. Either way
    // nothing installs itself — installing stays a user action, and
    // autoInstallOnAppQuit covers quitting.
    if (loadSettings().system.autoDownloadUpdate === true) {
      if (seen.fetchHandled) return
      void handleDownload('auto')
      return
    }
    if (seen.announced) return
    seen.announced = true
    notifyUpdate(
      t('main.updater.notifyAvailableTitle'),
      t('main.updater.notifyAvailableContent', { version: info.version })
    )
  })
  // The suppression record survives this on purpose: a check that reports
  // nothing (or fails) must not make the next cycle fetch a release it has
  // already dealt with.
  autoUpdater.on('update-not-available', () => setState({ status: 'latest', version: undefined }))
  autoUpdater.on('download-progress', (p) =>
    setState({ status: 'downloading', percent: Math.round(p.percent) })
  )
  autoUpdater.on('update-downloaded', (info) => {
    // Read before setState: `auto` says who started this download, and the state
    // keeps it (the About tab shows the automatic variant for it).
    const wasAuto = state.auto === true
    setState({ status: 'downloaded', version: info.version, percent: undefined })
    const seen = actedFor(info.version)
    // The package is on disk now, whoever fetched it (the user from the About
    // tab, or the auto-download above): the next cycle has nothing left to fetch
    // for this version.
    seen.fetchHandled = true
    // …and the release has reached its final state, which is what keeps a later
    // `update-available` for it from downgrading the UI back to 'available'.
    seen.downloaded = true
    // Only the silent background download has to be announced; a download the
    // user started from the About tab is already on screen. And only once per
    // version — the balloon is not a progress log.
    if (wasAuto && !seen.downloadedAnnounced) {
      seen.downloadedAnnounced = true
      notifyUpdate(
        t('main.updater.notifyDownloadedTitle'),
        t('main.updater.notifyDownloadedContent', { version: info.version })
      )
    }
  })
  autoUpdater.on('error', (err) =>
    setState({ status: 'error', error: err instanceof Error ? err.message : String(err) })
  )
}

/**
 * Bound one updater call with an overall timeout. electron-updater's own socket
 * idle timeout only fires on silence, so a slow trickling response can hold an
 * attempt — and the "checking" state the UI shows — open indefinitely.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    const handle = setTimeout(() => reject(new Error(t('main.updater.checkTimeout'))), ms)
    handle.unref?.()
    timer = handle
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

/**
 * Check updates: GitHub releases first (system proxy, gated by a
 * connectivity probe), domestic Gitea generic package as fallback.
 *
 * The feed is decided BEFORE touching the updater: a check abandoned on timeout
 * cannot be cancelled, and electron-updater de-dupes concurrent checks by
 * handing back the in-flight promise — so the fallback attempt below shares the
 * abandoned check's fate instead of racing a second request.
 */
async function checkWithFallback(): Promise<void> {
  // The feed choice is per attempt: a transient GitHub failure must not pin
  // every later check to Gitea (and its forced direct connection) — or vice
  // versa — for the whole session.
  let githubErr: string | undefined
  if (await probeGithub()) {
    useFeed('github')
    try {
      await withTimeout(autoUpdater.checkForUpdates(), budgets.check)
      return
    } catch (err) {
      console.warn('[updater] github feed failed, falling back to gitea:', err)
      githubErr = err instanceof Error ? err.message : String(err)
    }
  } else {
    console.warn('[updater] github probe failed or timed out, using gitea feed directly')
  }
  useFeed('gitea')
  try {
    // Bounded as well: a still-stuck GitHub check is handed back to us here, and
    // it must not leave the state at "checking" forever.
    await withTimeout(autoUpdater.checkForUpdates(), budgets.check)
  } catch (err) {
    if (githubErr === undefined) throw err
    const giteaErr = err instanceof Error ? err.message : String(err)
    throw new Error(t('main.updater.feedFailed', { gitea: giteaErr, github: githubErr }))
  }
}

async function performCheck(source: CheckSource): Promise<UpdateState> {
  if (!app.isPackaged) {
    setState({ status: 'dev', scheduled: source === 'scheduled' })
    return state
  }
  setState({
    status: 'checking',
    error: undefined,
    percent: undefined,
    scheduled: source === 'scheduled'
  })
  try {
    await checkWithFallback()
  } catch (err) {
    setState({
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
      scheduled: source === 'scheduled'
    })
  }
  return state
}

/**
 * The one check entry point: the IPC handler (manual), the startup timer and the
 * periodic timer all come through here, so the `scheduled` mark cannot be
 * attributed to the wrong caller. A check already running is shared instead of
 * started twice — electron-updater would de-dupe the two anyway, but it returns
 * its in-flight promise *to whoever asks first*, which is exactly how the source
 * mark would end up on the wrong attempt.
 */
export function runCheck(source: CheckSource = 'manual'): Promise<UpdateState> {
  // A manual check is an explicit act, so whatever it finds counts as news even
  // if this run has already dealt with that version: the suppression record is
  // dropped here — before the in-flight guard, so a click that joins a check
  // already running gets the same treatment. (A manual DOWNLOAD needs no
  // equivalent: its entry point never consults the record.)
  if (source === 'manual') actedRelease = undefined
  if (checkInFlight) return checkInFlight
  const task = performCheck(source)
  checkInFlight = task
  const release = (): void => {
    if (checkInFlight === task) checkInFlight = undefined
  }
  // Released on rejection too: performCheck reports failures as state rather
  // than throwing, but a stuck slot would silently stop every later check.
  task.then(release, release)
  return task
}

/** IPC entry point (设置 → 关于 "check now"): always a manual check. */
function handleCheck(): Promise<UpdateState> {
  return runCheck('manual')
}

/**
 * Download the update the last check found. `auto` marks a download started by
 * the `autoDownloadUpdate` setting; it is what the balloon and the About tab key
 * off. A failure lands on `status: 'error'` and is never retried here — the next
 * check (or the user) starts the next attempt, which is exactly why the claim
 * below is rolled back: a permanent claim would turn one failure into "auto
 * update never happens again for this release".
 */
async function handleDownload(source: DownloadSource = 'manual'): Promise<void> {
  // One transfer at a time: a second call would restart the same download.
  if (downloadInFlight) return downloadInFlight
  if (!app.isPackaged) return
  // Claim the version before the transfer starts, so another `update-available`
  // for it (the 4-hour cycle) cannot start a second one — and so a manual
  // download of that version already on disk is not re-fetched in the
  // background later. Rolled back on failure: a download that never finished
  // must be retried by the next check, and claiming it permanently would leave
  // auto-download silently dead.
  const seen = state.version === undefined ? undefined : actedFor(state.version)
  if (seen) seen.fetchHandled = true
  const task = (async (): Promise<void> => {
    setState({ status: 'downloading', percent: 0, auto: source === 'auto' })
    try {
      await autoUpdater.downloadUpdate()
    } catch (err) {
      if (seen) seen.fetchHandled = false
      setState({ status: 'error', error: err instanceof Error ? err.message : String(err) })
    }
  })()
  downloadInFlight = task
  const release = (): void => {
    if (downloadInFlight === task) downloadInFlight = undefined
  }
  task.then(release, release)
  return task
}

/** Direct-connection fetch for the domestic update channel (ignores system proxy). */
async function directFetch(url: string): Promise<Response> {
  const s = session.fromPartition('openterminal-update-direct', { cache: false })
  await s.setProxy({ mode: 'direct' })
  // Bounded: the changelog is on screen, so a stalled channel must fall through
  // to the releases APIs instead of leaving the view spinning.
  return s.fetch(url, {
    headers: { 'User-Agent': 'OpenTerminal' },
    signal: AbortSignal.timeout(budgets.fetch)
  })
}

/**
 * Connectivity probe for the GitHub feed: dedicated session in the same
 * proxy mode as the feed (system), hard timeout so proxy-less users fall
 * back to Gitea instead of hanging on a dead proxy/DNS.
 */
async function probeGithub(): Promise<boolean> {
  try {
    const s = session.fromPartition('openterminal-github-probe', { cache: false })
    await s.setProxy({ mode: 'system' })
    const resp = await s.fetch(GITHUB_PROBE_URL, {
      headers: { 'User-Agent': 'OpenTerminal' },
      signal: AbortSignal.timeout(budgets.probe)
    })
    return resp.ok
  } catch {
    return false
  }
}

/**
 * Changelog sources, in order:
 * 1. update channel's release-notes.md — the Gitea repo itself is private
 *    (anonymous API reads 404), but the generic package is publicly readable.
 * 2. Gitea / GitHub releases APIs (full history when reachable).
 */
async function fetchChangelog(): Promise<ReleaseNote[]> {
  try {
    const [notesResp, ymlResp] = await Promise.all([
      directFetch(`${GITEA_FEED}release-notes.md`),
      directFetch(`${GITEA_FEED}latest.yml`)
    ])
    if (notesResp.ok) {
      const body = await notesResp.text()
      const yml = ymlResp.ok ? await ymlResp.text() : ''
      const version = yml.match(/^version:\s*(\S+)/m)?.[1] ?? ''
      const date = yml.match(/^releaseDate:\s*'?(\S+?)'?$/m)?.[1]?.slice(0, 10) ?? ''
      if (body.trim()) return [{ version: version ? `v${version}` : 'latest', date, body }]
    }
  } catch {
    // fall through to releases APIs
  }
  for (const url of [GITEA_RELEASES_API, GITHUB_RELEASES_API]) {
    try {
      const resp = await net.fetch(url, {
        headers: { 'User-Agent': 'OpenTerminal' },
        signal: AbortSignal.timeout(budgets.fetch)
      })
      if (!resp.ok) continue
      const data = (await resp.json()) as Array<{
        tag_name?: string
        name?: string
        published_at?: string
        body?: string
      }>
      return data
        .map((r) => ({
          version: r.tag_name ?? r.name ?? '',
          date: (r.published_at ?? '').slice(0, 10),
          body: r.body ?? ''
        }))
        .filter((r) => r.version)
    } catch {
      // try next source
    }
  }
  return []
}

export function registerUpdateIpc(): void {
  ipcMain.handle(Ipc.UPDATE_CHECK, handleCheck)
  // Wrapped, not passed directly: an ipcMain handler receives the event as its
  // first argument, which would land in `source`.
  ipcMain.handle(Ipc.UPDATE_DOWNLOAD, () => handleDownload('manual'))
  ipcMain.handle(Ipc.UPDATE_INSTALL, () => {
    if (!app.isPackaged) return
    // The close interceptor (tray flow) would swallow this quit — mark first.
    markQuitting()
    // (isSilent, isForceRunAfter): relaunch the installed build, otherwise the
    // app would just disappear on "restart to update".
    autoUpdater.quitAndInstall(false, true)
  })
  ipcMain.handle(Ipc.UPDATE_CHANGELOG, fetchChangelog)
  ipcMain.handle(Ipc.UPDATE_STATE_GET, () => state)
}

export function configureAutoUpdater(): void {
  // Update checks only run in packaged builds; no-op during development.
  if (!app.isPackaged) {
    return
  }
  useFeed('gitea')
  wireEvents()
  autoUpdater.logger = console
  // Both halves of the update stay under our control: `autoDownload` is driven
  // by the `autoDownloadUpdate` setting (one source of truth, read in the
  // update-available handler) rather than by electron-updater, and nothing here
  // ever installs on its own — autoInstallOnAppQuit only covers quitting.
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  // The startup check and the periodic one are armed by applyUpdateSchedule
  // (wired in index.ts through settingsStore's injected applier) instead of
  // here: a settings save must re-arm the schedule, not add a second timer.
}

/**
 * Arm (or re-arm) the update schedule from the current settings. Called by
 * settingsStore's injected applier on startup and after every settings save, so
 * it must be idempotent: the previous interval timer is dropped first, and the
 * startup check is armed at most once per run — a settings save two seconds into
 * the run must not schedule a second "startup" check.
 *
 * Dev builds schedule nothing (there is no feed), which is also why the startup
 * flag is not set on the way out.
 */
export function applyUpdateSchedule(system: SystemSettings): void {
  if (intervalTimer) {
    clearInterval(intervalTimer)
    intervalTimer = undefined
  }
  if (!app.isPackaged) return

  // Startup check only when the user left it enabled (设置 → 关于). Left alone by
  // later calls, and unref'd like every other timer here: a pending check must
  // never keep the app (or a test process) alive.
  if (!startupArmed && system.autoCheckUpdate !== false) {
    startupArmed = true
    const startup = setTimeout(() => void runCheck('startup'), budgets.startupDelay)
    startup.unref?.()
  }

  // 0 = never: the startup and the manual check are all that is left. Any other
  // value is a whitelisted interval (settingsStore sanitizes it); the fallback
  // covers a hand-built SystemSettings.
  const hours = isUpdateCheckInterval(system.updateCheckIntervalHours)
    ? system.updateCheckIntervalHours
    : FALLBACK_CHECK_INTERVAL_HOURS
  if (hours > 0) {
    const timer = setInterval(() => void runCheck('scheduled'), hours * budgets.hour)
    timer.unref?.()
    intervalTimer = timer
  }

  // Auto-download switched on while an update was already found: start now, the
  // next tick could be hours away.
  if (system.autoDownloadUpdate === true && state.status === 'available') {
    void handleDownload('auto')
  }
}
