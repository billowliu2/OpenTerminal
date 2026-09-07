import type { ThemeColors } from '@shared/theme'

function parseHex(color: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{6})$/i.exec(color.trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function toHex(v: number): string {
  return Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')
}

/** t=0 → a, t=1 → b */
export function mix(a: string, b: string, t: number): string | null {
  const ca = parseHex(a)
  const cb = parseHex(b)
  if (!ca || !cb) return null
  return `#${toHex(ca[0] + (cb[0] - ca[0]) * t)}${toHex(ca[1] + (cb[1] - ca[1]) * t)}${toHex(ca[2] + (cb[2] - ca[2]) * t)}`
}

/** Derive the app chrome palette (sidebar, tab bars, dividers) from the active
 *  terminal theme so the whole window follows theme switches instead of only
 *  the terminal canvas. Values land on :root CSS variables; anything the theme
 *  can't provide keeps the static fallback in global.css. */
export function applyChromeTheme(colors: ThemeColors): void {
  const style = document.documentElement.style
  const set = (key: string, value: string | null): void => {
    if (value) style.setProperty(key, value)
  }
  set('--chrome-bg', colors.background)
  set('--chrome-fg', colors.foreground)
  set('--chrome-bg-deep', mix(colors.background, '#000000', 0.35))
  set('--chrome-hover', mix(colors.background, colors.foreground, 0.08))
  set('--chrome-border', mix(colors.background, colors.foreground, 0.16))
}

/** Tab accent: base color + a lightened foreground variant for text on dark
 *  tinted backgrounds. Consumed via var(--tab-accent*) in workspace.css. */
export function applyTabAccent(color: string): void {
  const style = document.documentElement.style
  // Settings hydrated from an older main process may lack the key; clear the
  // vars so the CSS fallbacks apply instead of an invalid "undefined" value.
  if (!color) {
    style.removeProperty('--tab-accent')
    style.removeProperty('--tab-accent-fg')
    return
  }
  style.setProperty('--tab-accent', color)
  style.setProperty('--tab-accent-fg', mix(color, '#ffffff', 0.18) ?? color)
}
