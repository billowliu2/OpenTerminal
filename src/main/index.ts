import { app, BrowserWindow, dialog, globalShortcut, net, nativeImage, protocol, shell } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { devRendererUrl } from './devEnv'
import { isTrustedRendererUrl, registerIpc } from './ipc'
import { killAllPtys, killPtysByOwner } from './pty'
import { applyStartupSystemSettings, loadSettings } from './settingsStore'
import { getLockController, initLockController } from './lockController'
import { applyMenuLockState } from './lockMenu'
import { isLockBlockedShortcut, isPanicLockChord } from './lockShortcuts'
import { initTray, markQuitting, onMainWindowClose, refreshTrayMenu } from './tray'
import { configureAutoUpdater, registerUpdateIpc } from './updater'
import { applyWindowChrome } from './windowChrome'
import { onLanguageChange, t } from '@shared/i18n'
import { getThemeById } from '@shared/theme'

/** Re-create the main window (tray restore path after all windows are gone). */
function showOrCreate(): void {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
  else {
    const win = BrowserWindow.getAllWindows()[0]
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }
}

/**
 * Hand a link to the OS browser. Only the web schemes are allowed: a renderer
 * that asked to open `file:`/`ms-*:`/anything else must not reach the shell.
 */
function openExternal(url: string): void {
  try {
    const { protocol } = new URL(url)
    if (protocol === 'http:' || protocol === 'https:' || protocol === 'ftp:') {
      void shell.openExternal(url)
    }
  } catch {
    // unparsable target: nothing to open
  }
}

// Dev runs get their own userData directory (settings, session snapshot,
// command history, logs) *and* their own single-instance lock — both are keyed
// on that path. Without this a dev instance fights the installed build: it
// takes the lock, so the other side is refused / must be killed, and it writes
// test data straight into the real profile. Must run before the lock below.
if (!app.isPackaged) {
  app.setPath('userData', join(app.getPath('appData'), 'OpenTerminal-dev'))
}

// Custom background image (设置 → 主题): the renderer page cannot load file:
// subresources directly (Chromium blocks them from non-file origins), so it
// references them through this scheme instead. The handler serves exactly one
// file — the configured background image — nothing else.
protocol.registerSchemesAsPrivileged([
  { scheme: 'otimg', privileges: { secure: true, supportFetchAPI: false, corsEnabled: false } }
])

// Single instance: a second launch just surfaces the existing window (pulls
// it out of the tray if hidden there) instead of starting another process.
// The refused instance skips the whole startup path: `app.quit()` only asks
// the app to exit, so running the `whenReady` init behind it left a second
// process with IPC, a tray and an updater but no window.
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => showOrCreate())

  app
    .whenReady()
    .then(() => {
      // Serve the configured background image (path lives in settings; anything
      // else — including a path that is no longer configured — is refused, so the
      // protocol cannot be used to read arbitrary files).
      protocol.handle('otimg', (request) => {
        const url = new URL(request.url)
        const requested = decodeURIComponent(url.pathname.replace(/^\//, ''))
        const allowed = loadSettings().terminal.backgroundImage
        if (allowed === '' || requested !== allowed || !existsSync(requested)) {
          return new Response('', { status: 403 })
        }
        return net.fetch(pathToFileURL(requested).toString())
      })

      registerIpc()
      registerUpdateIpc()
      // Before the window exists: a renderer-triggered check must not run against
      // the updater's defaults (feed, proxy, autoDownload are set in here).
      configureAutoUpdater()
      // OS-level effects (login item, sleep blocker) must apply even if the
      // settings dialog is never opened this run.
      applyStartupSystemSettings(loadSettings())
      // The lock state has to exist before the window loads, so a lockAtStartup
      // lock is already in place when the renderer asks for it. It also starts the
      // idle watcher, which is why it belongs after ready: powerMonitor cannot be
      // touched before that. A restored startup lock engages before any publish,
      // so the menu teardown is applied here from the flag itself.
      const lock = initLockController()
      applyMenuLockState(lock.isLocked())
      // A second launch that raced this startup already created (or surfaced) a
      // window from its `second-instance` handler; creating another here would
      // leave two. Same guard the activate handler below uses.
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
      initTray(showOrCreate)
      // Tray labels are resolved from the dictionary at build time, so the menu has
      // to be rebuilt whenever the interface language changes.
      onLanguageChange(() => refreshTrayMenu())

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow()
      })
    })
    // A throw anywhere above (protocol, IPC, updater, lock controller, window,
    // tray) used to leave the process running with the single-instance lock held
    // and neither a window nor a tray to reach it — a zombie that refuses every
    // later launch. Report and exit so a relaunch can retry from scratch.
    .catch((err: unknown) => {
      console.error('[main] startup failed:', err)
      try {
        dialog.showErrorBox(
          'OpenTerminal',
          t('main.startupFailed', { detail: err instanceof Error ? err.message : String(err) })
        )
      } catch {
        // no display / dialog unavailable: the console line is all we have
      }
      app.exit(1)
    })
}

function createWindow(): void {
  // Dev-mode window/taskbar icon; packaged builds inherit the exe icon
  // (electron-builder embeds build/icon.png), so undefined is fine there.
  const devIcon = join(__dirname, '../../build/icon.png')
  const settings = loadSettings()
  const theme = getThemeById(settings.terminal.themeId, settings.customThemes)
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    show: false,
    backgroundColor: theme.colors.background,
    autoHideMenuBar: true,
    // Custom title bar: the renderer draws the strip, Windows draws the
    // min/max/close overlay — colors follow the active terminal theme.
    ...(process.platform === 'win32'
      ? {
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: {
            color: theme.colors.background,
            symbolColor: theme.colors.foreground,
            height: 36
          }
        }
      : {}),
    ...(existsSync(devIcon) ? { icon: nativeImage.createFromPath(devIcon) } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // Written out explicitly even though every value matches Electron's
      // current default: these are the three that keep the renderer unable to
      // reach the main process, and a default that silently changed (or a
      // future Electron release flipping one) must not be the only thing
      // holding that line. See also the sender guard in ipc.ts.
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      // Keep the default renderer sandbox (preload only touches the electron
      // IPC bridge, so it does not need Node access).
      sandbox: true
    }
  })

  // Ctrl+L is the panic lock: it must work from anywhere in the app, terminals
  // included, so it is captured here ahead of the page. It only takes the chord
  // away when a lock actually engages — an unconfigured app keeps Ctrl+L for
  // the shell's clear-screen. Auto-repeats are skipped: the first keydown
  // decides, and on an unconfigured app each repeat would otherwise re-read
  // lock.json + settings.json from disk (~30 keydown/s while held).
  // Swallow the menu accelerators that would otherwise act behind the lock
  // overlay (see isLockBlockedShortcut). A throw in here would break typing
  // altogether, so the whole guard is defensive.
  win.webContents.on('before-input-event', (event, input) => {
    try {
      if (input.type !== 'keyDown') return
      const lock = getLockController()
      if (!lock.isLocked() && isPanicLockChord(input)) {
        if (!input.isAutoRepeat && lock.lockNow().locked) event.preventDefault()
        return
      }
      if (!lock.isLocked()) return
      if (isLockBlockedShortcut(input)) event.preventDefault()
    } catch {
      /* an input guard must never take the window down with it */
    }
  })

  win.on('ready-to-show', () => win.show())

  // Dev window wears a "(dev)" tag so it is never confused with the installed
  // build sitting next to it (they no longer share userData — see above).
  if (!app.isPackaged) {
    win.on('page-title-updated', (e) => {
      e.preventDefault()
      win.setTitle('OpenTerminal (dev)')
    })
  }

  // Close button → tray / exit per the closeAction setting (ask by default).
  win.on('close', (e) => {
    void onMainWindowClose(win, e, showOrCreate)
  })

  // Surface renderer console errors in the dev terminal for diagnosis.
  win.webContents.on('console-message', (event) => {
    if (event.level === 'error') {
      console.error(`[renderer] ${event.message}`)
    }
  })

  // A renderer that crashed or was destroyed without running its own cleanup
  // (normal close/reload kills its sessions via beforeunload first) leaves
  // orphaned PTY/SSH transports behind — and session logs that keep appending.
  const dropOwnedSessions = (): void => killPtysByOwner(win.webContents.id)
  win.webContents.on('render-process-gone', dropOwnedSessions)
  win.webContents.on('destroyed', dropOwnedSessions)

  win.webContents.setWindowOpenHandler((details) => {
    openExternal(details.url)
    return { action: 'deny' }
  })

  // Dropping a local .html file on the window is a navigation like any other,
  // and the new document would inherit this window's privileged preload. Only
  // the app's own page may (re)load here.
  win.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedRendererUrl(url)) event.preventDefault()
  })

  // ELECTRON_RENDERER_URL is honored in dev builds only — a packaged build must
  // always load the bundled renderer file, no matter what the environment says.
  // Both loads are fire-and-forget, so the rejection is surfaced explicitly
  // instead of dying as a floating promise.
  const devUrl = devRendererUrl()
  if (devUrl) {
    void win.loadURL(devUrl).catch((err) => {
      console.error('[main] loadURL failed:', err)
    })
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html')).catch((err) => {
      console.error('[main] loadFile failed:', err)
    })
  }
}

process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandledRejection:', reason)
})
process.on('uncaughtException', (err) => {
  console.error('[main] uncaughtException:', err)
})

// Diagnostics for "app froze then recovered" reports: WER logs an
// AppHangTransient but keeps no stack. A stall of THIS (UI) thread is what
// Windows flags as a hang, so measure event-loop lag and say so loudly when
// it happens — that distinguishes a main-process block from a renderer one.
let lastTick = Date.now()
setInterval(() => {
  const now = Date.now()
  const lag = now - lastTick - 1000
  if (lag > 2000) console.error(`[main] event loop stalled ~${lag}ms`)
  lastTick = now
}, 1000).unref()

app.on('before-quit', () => {
  // Let window 'close' events pass through so teardown completes.
  markQuitting()
  killAllPtys()
  globalShortcut.unregisterAll()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})