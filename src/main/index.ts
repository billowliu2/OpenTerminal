import { app, BrowserWindow, globalShortcut, nativeImage, shell } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { registerIpc } from './ipc'
import { killAllPtys } from './pty'
import { applyStartupSystemSettings, loadSettings } from './settingsStore'
import { initTray, markQuitting, onMainWindowClose } from './tray'
import { configureAutoUpdater } from './updater'
import { applyWindowChrome } from './windowChrome'
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

// Single instance: a second launch just surfaces the existing window (pulls
// it out of the tray if hidden there) instead of starting another process.
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => showOrCreate())
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
      sandbox: false
    }
  })

  win.on('ready-to-show', () => win.show())

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

  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    win.loadURL(devUrl)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandledRejection:', reason)
})
process.on('uncaughtException', (err) => {
  console.error('[main] uncaughtException:', err)
})

app.whenReady().then(() => {
  registerIpc()
  // OS-level effects (login item, sleep blocker) must apply even if the
  // settings dialog is never opened this run.
  applyStartupSystemSettings(loadSettings())
  createWindow()
  initTray(showOrCreate)
  configureAutoUpdater()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  // Let window 'close' events pass through so teardown completes.
  markQuitting()
  killAllPtys()
  globalShortcut.unregisterAll()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})