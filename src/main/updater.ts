import { app, ipcMain, net, session } from 'electron'
import { autoUpdater } from 'electron-updater'
import { Ipc, type ReleaseNote, type UpdateState } from '../shared/ipc'
import { t } from '../shared/i18n'
import { broadcast } from './broadcast'
import { devUpdateFeedUrl } from './devEnv'
import { loadSettings } from './settingsStore'
import { markQuitting } from './tray'

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
const GITHUB_PROBE_TIMEOUT_MS = 20_000
/** Overall budget for ONE check attempt — see withTimeout. */
const CHECK_TIMEOUT_MS = 30_000
/** Changelog / releases-API fetches: a stalled response must not hang the About tab. */
const FETCH_TIMEOUT_MS = 15_000

let state: UpdateState = { status: 'idle', currentVersion: app.getVersion() }
let activeFeed: 'gitea' | 'github' = 'gitea'
let eventsWired = false

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
  autoUpdater.on('update-available', (info) =>
    setState({ status: 'available', version: info.version, feed: activeFeed, percent: undefined })
  )
  autoUpdater.on('update-not-available', () => setState({ status: 'latest', version: undefined }))
  autoUpdater.on('download-progress', (p) =>
    setState({ status: 'downloading', percent: Math.round(p.percent) })
  )
  autoUpdater.on('update-downloaded', (info) =>
    setState({ status: 'downloaded', version: info.version, percent: undefined })
  )
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
      await withTimeout(autoUpdater.checkForUpdates(), CHECK_TIMEOUT_MS)
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
    await withTimeout(autoUpdater.checkForUpdates(), CHECK_TIMEOUT_MS)
  } catch (err) {
    if (githubErr === undefined) throw err
    const giteaErr = err instanceof Error ? err.message : String(err)
    throw new Error(t('main.updater.feedFailed', { gitea: giteaErr, github: githubErr }))
  }
}

async function handleCheck(): Promise<UpdateState> {
  if (!app.isPackaged) {
    setState({ status: 'dev' })
    return state
  }
  setState({ status: 'checking', error: undefined, percent: undefined })
  try {
    await checkWithFallback()
  } catch (err) {
    setState({ status: 'error', error: err instanceof Error ? err.message : String(err) })
  }
  return state
}

async function handleDownload(): Promise<void> {
  if (!app.isPackaged) return
  setState({ status: 'downloading', percent: 0 })
  try {
    await autoUpdater.downloadUpdate()
  } catch (err) {
    setState({ status: 'error', error: err instanceof Error ? err.message : String(err) })
  }
}

/** Direct-connection fetch for the domestic update channel (ignores system proxy). */
async function directFetch(url: string): Promise<Response> {
  const s = session.fromPartition('openterminal-update-direct', { cache: false })
  await s.setProxy({ mode: 'direct' })
  // Bounded: the changelog is on screen, so a stalled channel must fall through
  // to the releases APIs instead of leaving the view spinning.
  return s.fetch(url, {
    headers: { 'User-Agent': 'OpenTerminal' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
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
      signal: AbortSignal.timeout(GITHUB_PROBE_TIMEOUT_MS)
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
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
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
  ipcMain.handle(Ipc.UPDATE_DOWNLOAD, handleDownload)
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
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  // Startup check only when the user left it enabled (设置 → 关于).
  if (loadSettings().system.autoCheckUpdate === false) return
  const timer = setTimeout(() => {
    void handleCheck()
  }, 5000)
  timer.unref?.()
}
