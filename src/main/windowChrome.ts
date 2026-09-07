import { BrowserWindow } from 'electron'
import type { AppSettings } from '@shared/settings'
import { getThemeById } from '@shared/theme'

/** Title bar overlay + window background follow the active terminal theme. */
export function applyWindowChrome(settings: AppSettings): void {
  const theme = getThemeById(settings.terminal.themeId, settings.customThemes)
  const bg = theme.colors.background
  const fg = theme.colors.foreground
  for (const win of BrowserWindow.getAllWindows()) {
    win.setBackgroundColor(bg)
    if (process.platform === 'win32') {
      win.setTitleBarOverlay({ color: bg, symbolColor: fg, height: 36 })
    }
  }
}
