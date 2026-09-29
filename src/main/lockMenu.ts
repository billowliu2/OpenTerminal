import { Menu } from 'electron'

/**
 * Remove the application menu while the lock screen is up, restore it on unlock.
 *
 * `before-input-event` only sees the keyboard: with the default menu in place,
 * pressing Alt reveals the hidden menu bar (`autoHideMenuBar`) and a mouse click
 * on View → Reload / Toggle Developer Tools / Zoom still runs behind — or
 * against — the opaque overlay. Reload kills every session behind the mask via
 * beforeunload; DevTools makes the hidden DOM readable. Neither is reachable
 * once the menu is gone, and the lock's keyboard guard (lockShortcuts.ts) keeps
 * covering the chords in dev, where the menu is the developer's tool.
 *
 * The restore template mirrors Electron's own default menu (default-menu.ts):
 * the app never installs a custom one, so this rebuilds exactly what was there.
 */
let menuRemoved = false

export function applyMenuLockState(locked: boolean): void {
  if (menuRemoved === locked) return
  menuRemoved = locked
  if (locked) {
    Menu.setApplicationMenu(null)
    return
  }
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin'
      ? [{ role: 'appMenu' as const }]
      : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
