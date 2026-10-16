import type { ThemeColors } from '@shared/theme'
import { contrast, isLightTheme, mix, semanticVars } from './semantic'

// 兼容既有导入方（main.tsx 的 mix）；新代码请直接从 ./semantic 导入。
export { contrast, luminance, mix } from './semantic'

/** Whether the active terminal theme has a light background. Tab bars derived
 *  from it flip their overlay direction (white-on-dark vs black-on-light). */
let chromeIsLight = false

/** Dark-chrome tab label: the background mixed toward the theme's own foreground
 *  (the light branch is the same mix toward black), but never below 4.5:1 against
 *  the background, since a theme foreground dimmed by 0.68 can land unreadable. */
function tabLabel(background: string, foreground: string, t: number): string {
  const mixed = mix(background, foreground, t)
  return mixed && contrast(mixed, background) >= 4.5 ? mixed : foreground
}

/** Accent color from the last applyTabAccent() call; re-applied at the end of a
 *  chrome theme change so --tab-accent-fg follows the new theme's luminance. */
let tabAccent = ''

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
  chromeIsLight = isLightTheme(colors.background)
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
    set('--chrome-tab-fg', tabLabel(colors.background, colors.foreground, 0.68))
    set('--chrome-tab-fg-hover', tabLabel(colors.background, colors.foreground, 0.88))
  }
  // Semantic layer: --ot-* variables consumed by panels, popovers and inline
  // styles. The dark branch locks the SEMANTIC anchors (zero visual change);
  // the light branch darkens them until the WCAG ratio holds against this
  // theme's background. `color-scheme` rides along so native scrollbars and
  // form controls follow the same switch.
  const vars = semanticVars(colors, chromeIsLight)
  for (const [key, value] of Object.entries(vars)) {
    if (key === 'colorScheme') style.setProperty('color-scheme', value)
    else set(`--ot-${key}`, value)
  }
  applyTabAccent(tabAccent)
}

/** Tab accent: base color + a foreground variant that stays readable on the
 *  bar (lightened on dark chrome, darkened on light chrome). Consumed via
 *  var(--tab-accent*) in workspace.css. */
export function applyTabAccent(color: string): void {
  const style = document.documentElement.style
  tabAccent = color
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
