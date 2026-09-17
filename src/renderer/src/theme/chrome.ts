import type { ThemeColors } from '@shared/theme'

function parseHex(color: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{6})$/i.exec(color.trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** WCAG relative luminance (0=black, 1=white); null for non-hex input. */
function luminance(color: string): number | null {
  const c = parseHex(color)
  if (!c) return null
  const lin = c.map((v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]
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

/** Whether the active terminal theme has a light background. Tab bars derived
 *  from it flip their overlay direction (white-on-dark vs black-on-light). */
let chromeIsLight = false

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
  chromeIsLight = (luminance(colors.background) ?? 0) > 0.5
  if (chromeIsLight) {
    // Light chrome: keep the bar close to the background (a big mix toward
    // black turns pale themes into a muddy gray strip) and overlay tabs with
    // translucent black instead of the translucent white used on dark themes.
    set('--chrome-bg-deep', mix(colors.background, '#000000', 0.08))
    set('--chrome-hover', mix(colors.background, '#000000', 0.06))
    set('--chrome-border', mix(colors.background, '#000000', 0.2))
    set('--chrome-tab-bg', 'rgba(0, 0, 0, 0.045)')
    set('--chrome-tab-bg-hover', 'rgba(0, 0, 0, 0.09)')
    set('--chrome-tab-ring', 'rgba(0, 0, 0, 0.18)')
    set('--chrome-tab-ring-hover', 'rgba(0, 0, 0, 0.32)')
    set('--chrome-tab-fg', mix(colors.background, '#000000', 0.68))
    set('--chrome-tab-fg-hover', mix(colors.background, '#000000', 0.88))
  } else {
    set('--chrome-bg-deep', mix(colors.background, '#000000', 0.35))
    set('--chrome-hover', mix(colors.background, colors.foreground, 0.08))
    set('--chrome-border', mix(colors.background, colors.foreground, 0.16))
    set('--chrome-tab-bg', 'rgba(255, 255, 255, 0.04)')
    set('--chrome-tab-bg-hover', 'rgba(255, 255, 255, 0.07)')
    set('--chrome-tab-ring', 'rgba(255, 255, 255, 0.1)')
    set('--chrome-tab-ring-hover', 'rgba(255, 255, 255, 0.2)')
    set('--chrome-tab-fg', '#98a2ab')
    set('--chrome-tab-fg-hover', '#d0d0d0')
  }
}

/** Tab accent: base color + a foreground variant that stays readable on the
 *  bar (lightened on dark chrome, darkened on light chrome). Consumed via
 *  var(--tab-accent*) in workspace.css. */
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
  const fg = chromeIsLight ? mix(color, '#000000', 0.35) : mix(color, '#ffffff', 0.18)
  style.setProperty('--tab-accent-fg', fg ?? color)
}
