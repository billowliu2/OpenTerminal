import { BrowserWindow, globalShortcut } from 'electron'

/**
 * Register the global show/hide toggle for the main window.
 *
 * - accelerator '' / undefined  => disabled (no global key bound).
 * - Passing an invalid accelerator string makes Electron's register() throw;
 *   we swallow that here so a bad user-supplied value never crashes the app.
 * - register() returning false means the accelerator is already taken by
 *   another application; we only log a warning and keep running.
 */
export function applyGlobalShortcut(accelerator: string | undefined): void {
  // No other global shortcuts are registered anywhere in this app, so a full
  // unregister is safe and guarantees a clean re-register on every change.
  globalShortcut.unregisterAll()
  if (!accelerator) return

  const handler = (): void => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win || win.isDestroyed()) return
    if (win.isVisible() && win.isFocused()) {
      win.hide()
    } else {
      win.show()
      win.focus()
    }
  }

  try {
    const ok = globalShortcut.register(accelerator, handler)
    if (!ok) {
      console.warn(`[global-shortcut] register "${accelerator}" failed (conflict with another app)`)
    }
  } catch (err) {
    console.warn(`[global-shortcut] register "${accelerator}" threw`, err)
  }
}