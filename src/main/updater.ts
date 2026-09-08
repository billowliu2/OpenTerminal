import { app, ipcMain, net, session } from 'electron'
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
    // Domestic feed: always direct — a system proxy only breaks it.
    void autoUpdater.netSession.setProxy({ mode: 'direct' })
    const token = process.env.OT_UPDATE_TOKEN
    autoUpdater.setFeedURL({
      provider: 'generic',
      url: process.env.OT_UPDATE_URL || GITEA_FEED,
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

/** Check the active feed; on failure switch Gitea → GitHub and retry once. */
async function checkWithFallback(): Promise<void> {
  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    if (activeFeed !== 'gitea') throw err
    console.warn('[updater] gitea feed failed, falling back to github:', err)
    const giteaErr = err instanceof Error ? err.message : String(err)
    useFeed('github')
    try {
      await autoUpdater.checkForUpdates()
    } catch (err2) {
      const ghErr = err2 instanceof Error ? err2.message : String(err2)
      throw new Error(`国内源: ${giteaErr}；GitHub: ${ghErr}`)
    }
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
  return s.fetch(url, { headers: { 'User-Agent': 'OpenTerminal' } })
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
