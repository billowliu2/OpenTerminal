import { app } from 'electron'
import { autoUpdater } from 'electron-updater'

/**
 * Default update feed (generic provider). The main agent uploads latest.yml and
 * the NSIS installer to this stable path.
 *
 * KNOWN LIMITATION: electron-updater does NOT support MSI auto-updates. The
 * update channel always runs through the NSIS .exe (latest.yml + .exe are
 * uploaded together). MSI is manual/enterprise distribution only.
 */
const DEFAULT_FEED_URL =
  'https://git.codingplan.site/api/packages/admin/generic/openterminal-update/stable/'

export function configureAutoUpdater(): void {
  // Update checks only run in packaged builds; no-op during development.
  if (!app.isPackaged) {
    return
  }

  const url = process.env.OT_UPDATE_URL || DEFAULT_FEED_URL
  const token = process.env.OT_UPDATE_TOKEN

  autoUpdater.setFeedURL({
    provider: 'generic',
    url,
    ...(token ? { requestHeaders: { Authorization: `token ${token}` } } : {})
  })

  autoUpdater.logger = console
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  // Check shortly after startup; log errors without crashing the app.
  const timer = setTimeout(() => {
    autoUpdater
      .checkForUpdatesAndNotify()
      .catch((err) => console.warn('[updater] checkForUpdates failed:', err))
  }, 5000)
  timer.unref?.()
}

/** Public entry point for later UI wiring (not connected this milestone). */
export function checkForUpdates(): Promise<void> {
  if (!app.isPackaged) {
    return Promise.resolve()
  }
  return autoUpdater
    .checkForUpdates()
    .then(() => {})
    .catch((err) => {
      console.warn('[updater] checkForUpdates failed:', err)
    })
}