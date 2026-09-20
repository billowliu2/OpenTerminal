import { app, BrowserWindow, dialog, Menu, nativeImage, Tray } from 'electron'
import type { SystemSettings } from '@shared/settings'
import { t } from '@shared/i18n'
import { loadSettings, mutateSettings } from './settingsStore'
import trayIconPath from './assets/tray.png?asset'

export type CloseAction = NonNullable<SystemSettings['closeAction']>

let tray: Tray | null = null
let quitting = false
let balloonShown = false
/** Window-restore callback handed to initTray; kept so the menu can be rebuilt. */
let showOrCreateRef: (() => void) | null = null

/** Once true, window close events pass through and the app really quits. */
export function markQuitting(): void {
  quitting = true
}

function persistCloseAction(action: CloseAction): void {
  // Serialized read-modify-write on the latest state: must not stomp (or be
  // stomped by) a concurrent full-snapshot save from the settings UI.
  void mutateSettings((current) => {
    current.system.closeAction = action
    return current
  })
}

function showMainWindow(showOrCreate: () => void): void {
  const win = BrowserWindow.getAllWindows()[0]
  if (win) {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  } else {
    showOrCreate()
  }
}

/** Rebuild the context menu so the close-action radio items reflect settings. */
function refreshContextMenu(showOrCreate: () => void): void {
  if (!tray) return
  const action = loadSettings().system.closeAction ?? 'tray'
  const setAction = (value: CloseAction) => (): void => {
    persistCloseAction(value)
    refreshContextMenu(showOrCreate)
  }
  // Labels are resolved while the template is built, so rebuilding the menu
  // after a language change picks up the new strings.
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: t('main.tray.showWindow'), click: (): void => showMainWindow(showOrCreate) },
      { type: 'separator' },
      { label: t('main.tray.closeAction'), enabled: false },
      { label: t('main.tray.askEveryTime'), type: 'radio', checked: action === 'ask', click: setAction('ask') },
      { label: t('main.tray.minimizeToTray'), type: 'radio', checked: action === 'tray', click: setAction('tray') },
      { label: t('main.tray.exitDirectly'), type: 'radio', checked: action === 'exit', click: setAction('exit') },
      { type: 'separator' },
      {
        label: t('main.tray.exit'),
        click: (): void => {
          markQuitting()
          app.quit()
        }
      }
    ])
  )
}

/**
 * Rebuild the tray menu (after a language change, or any time the labels must
 * be current). Safe to call before the tray exists.
 */
export function refreshTrayMenu(): void {
  if (!tray || !showOrCreateRef) return
  refreshContextMenu(showOrCreateRef)
}

/** Create the tray icon and wire left-click to window restore. */
export function initTray(showOrCreate: () => void): void {
  const icon = nativeImage.createFromPath(trayIconPath)
  tray = new Tray(icon)
  showOrCreateRef = showOrCreate
  tray.setToolTip('OpenTerminal')
  tray.on('click', (): void => showMainWindow(showOrCreate))
  refreshContextMenu(showOrCreate)
}

function hideToTray(win: BrowserWindow): void {
  win.hide()
  if (process.platform === 'win32' && tray && !balloonShown) {
    balloonShown = true
    tray.displayBalloon({
      iconType: 'info',
      // The Windows toast already prints the app name as its header, so the
      // balloon title carries the state only — no "OpenTerminal" twice.
      title: t('main.tray.balloonTitle'),
      content: t('main.tray.balloonContent')
    })
  }
}

/**
 * Window close interception. Must be called synchronously from the 'close'
 * event: preventDefault happens before any await on every branch.
 */
export async function onMainWindowClose(win: BrowserWindow, e: Electron.Event, showOrCreate: () => void): Promise<void> {
  if (quitting) return
  const action = loadSettings().system.closeAction ?? 'tray'
  if (action === 'tray') {
    e.preventDefault()
    hideToTray(win)
    return
  }
  if (action === 'exit') return // fall through: close proceeds, app quits
  e.preventDefault()
  const { response, checkboxChecked } = await dialog.showMessageBox(win, {
    type: 'question',
    title: t('main.tray.closeTitle'),
    message: t('main.tray.closeMessage'),
    detail: t('main.tray.closeDetail'),
    buttons: [t('main.tray.minimizeToTray'), t('main.tray.exitDirectly')],
    defaultId: 0,
    cancelId: 1,
    checkboxLabel: t('main.tray.rememberChoice'),
    checkboxChecked: false,
    noLink: true
  })
  if (response === 0) {
    if (checkboxChecked) persistCloseAction('tray')
    hideToTray(win)
  } else {
    if (checkboxChecked) persistCloseAction('exit')
    markQuitting()
    app.quit()
  }
  refreshContextMenu(showOrCreate)
}
