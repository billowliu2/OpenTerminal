import { app, ipcMain, net } from 'electron'
import { autoUpdater } from 'electron-updater'
import { Ipc, type ReleaseNote, type UpdateState } from '../shared/ipc'
import { broadcast } from './broadcast'
import { loadSettings } from './settingsStore'
import { markQuitting } from './tray'

/**
 * Update feeds: domestic Gitea generic package is tried first (fast in
 * China); GitHub releases is the fallback. Both feeds carry the NSIS .exe —
 * electron-updater does NOT support MSI auto-updates, MSI is manual only.
 */
const GITEA_FEED =
  'https://git.codingplan.site/api/packages/admin/generic/openterminal-update/stable/'
const GITEA_RELEASES_API =
  'https://git.codingplan.site/api/v1/repos/admin/OpenTerminal/releases?limit=10'
const GITHUB_REPO = { owner: 'billowliu2', repo: 'OpenTerminal' }
const GITHUB_RELEASES_API =
  'https://api.github.com/repos/billowliu2/OpenTerminal/releases?per_page=10'

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
    const token = process.env.OT_UPDATE_TOKEN
    autoUpdater.setFeedURL({
      provider: 'generic',
      url: process.env.OT_UPDATE_URL || GITEA_FEED,
      ...(token ? { requestHeaders: { Authorization: `token ${token}` } } : {})
    })
  } else {
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

/** Check the active feed; on failure switch Gitea → GitHub and retry once. */
async function checkWithFallback(): Promise<void> {
  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    if (activeFeed !== 'gitea') throw err
    console.warn('[updater] gitea feed failed, falling back to github:', err)
    useFeed('github')
    await autoUpdater.checkForUpdates()
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

/** Gitea releases first, GitHub releases as fallback; both are public reads. */
async function fetchChangelog(): Promise<ReleaseNote[]> {
  for (const url of [GITEA_RELEASES_API, GITHUB_RELEASES_API]) {
    try {
      const resp = await net.fetch(url, { headers: { 'User-Agent': 'OpenTerminal' } })
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
    // The close interceptor (tray flow) would swallow this quit — mark first.
    markQuitting()
    autoUpdater.quitAndInstall()
  })
  ipcMain.handle(Ipc.UPDATE_CHANGELOG, fetchChangelog)
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
