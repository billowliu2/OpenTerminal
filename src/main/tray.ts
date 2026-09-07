import { app, BrowserWindow, dialog, Menu, nativeImage, Tray } from 'electron'
import type { SystemSettings } from '@shared/settings'
import { loadSettings, saveSettings } from './settingsStore'
import trayIconPath from './assets/tray.png?asset'

export type CloseAction = NonNullable<SystemSettings['closeAction']>

let tray: Tray | null = null
let quitting = false
let balloonShown = false

/** Once true, window close events pass through and the app really quits. */
export function markQuitting(): void {
  quitting = true
}

function persistCloseAction(action: CloseAction): void {
  const next = loadSettings()
  next.system.closeAction = action
  saveSettings(next)
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
  const action = loadSettings().system.closeAction ?? 'ask'
  const setAction = (value: CloseAction) => (): void => {
    persistCloseAction(value)
    refreshContextMenu(showOrCreate)
  }
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示主窗口', click: (): void => showMainWindow(showOrCreate) },
      { type: 'separator' },
      { label: '关闭按钮行为', enabled: false },
      { label: '每次询问', type: 'radio', checked: action === 'ask', click: setAction('ask') },
      { label: '最小化到托盘', type: 'radio', checked: action === 'tray', click: setAction('tray') },
      { label: '直接退出', type: 'radio', checked: action === 'exit', click: setAction('exit') },
      { type: 'separator' },
      {
        label: '退出',
        click: (): void => {
          markQuitting()
          app.quit()
        }
      }
    ])
  )
}

/** Create the tray icon and wire left-click to window restore. */
export function initTray(showOrCreate: () => void): void {
  const icon = nativeImage.createFromPath(trayIconPath)
  tray = new Tray(icon)
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
      title: 'OpenTerminal 仍在运行',
      content: '已最小化到系统托盘，终端会话保持运行。点击托盘图标可恢复窗口。'
    })
  }
}

/**
 * Window close interception. Must be called synchronously from the 'close'
 * event: preventDefault happens before any await on every branch.
 */
export async function onMainWindowClose(win: BrowserWindow, e: Electron.Event, showOrCreate: () => void): Promise<void> {
  if (quitting) return
  const action = loadSettings().system.closeAction ?? 'ask'
  if (action === 'tray') {
    e.preventDefault()
    hideToTray(win)
    return
  }
  if (action === 'exit') return // fall through: close proceeds, app quits
  e.preventDefault()
  const { response, checkboxChecked } = await dialog.showMessageBox(win, {
    type: 'question',
    title: '关闭 OpenTerminal',
    message: '最小化到托盘，还是直接退出？',
    detail: '最小化到托盘时终端会话保持运行。',
    buttons: ['最小化到托盘', '直接退出'],
    defaultId: 0,
    cancelId: 1,
    checkboxLabel: '记住我的选择，不再询问',
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
