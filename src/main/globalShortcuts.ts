import { BrowserWindow, globalShortcut } from 'electron'

/**
 * Chords the app owns outright: Ctrl+L is the panic lock, captured in the main
 * window's before-input-event. The settings recorder (SettingsTabs.tsx,
 * RESERVED_EXACT_ACCELERATORS) refuses to save it, but that guard only covers
 * values entered after it existed — a shortcut persisted by an older build
 * still arrives here, and a global registration intercepts the key at the OS
 * level even while the window is focused, silently killing the lock shortcut.
 * Normalized (modifier aliases + case folded) so every spelling is caught.
 */
const RESERVED_ACCELERATORS = new Set(['control+l', 'commandorcontrol+l'])

function normalizeAccelerator(accelerator: string): string {
  return accelerator
    .split('+')
    .map((part) => {
      const p = part.trim().toLowerCase()
      if (p === 'ctrl') return 'control'
      if (p === 'cmdorctrl' || p === 'commandorctrl') return 'commandorcontrol'
      return p
    })
    .join('+')
}

/**
 * Register the global show/hide toggle for the main window.
 *
 * - accelerator '' / undefined  => disabled (no global key bound).
 * - A reserved chord (Ctrl+L) is skipped: see RESERVED_ACCELERATORS.
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

  if (RESERVED_ACCELERATORS.has(normalizeAccelerator(accelerator))) {
    console.warn(
      `[global-shortcut] "${accelerator}" is reserved for the Ctrl+L lock shortcut; not registering`
    )
    return
  }

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