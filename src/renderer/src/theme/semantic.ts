/**
 * Semantic color layer for app chrome. PURE module: no imports (it is loaded
 * directly by tests/semantic-theme.mjs via Node's native TS type stripping),
 * no DOM access. chrome.ts turns semanticVars() into --ot-* CSS variables on
 * <html> whenever the terminal theme changes.
 *
 * Dark-branch values are LOCKED to the historical literals (zero visual
 * regression); light-branch values are derived per-theme by darkening the
 * same anchors until the WCAG ratio is met.
 */

interface ThemeLike {
  background: string
  foreground: string
}

function parseHex(color: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{6})$/i.exec(color.trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** WCAG relative luminance (0=black, 1=white); null for non-hex input. */
export function luminance(color: string): number | null {
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

/** WCAG contrast ratio; 21 when either side is not parseable hex. */
export function contrast(a: string, b: string): number {
  const la = luminance(a)
  const lb = luminance(b)
  if (la === null || lb === null) return 21
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

export function isLightTheme(background: string): boolean {
  return (luminance(background) ?? 0) > 0.5
}

/** Darken `color` toward black in 0.05 steps until contrast vs `bg` >= ratio.
 *  Returns the input unchanged when it already passes (or never parses). */
export function darkenToRatio(color: string, bg: string, ratio: number): string {
  if (contrast(color, bg) >= ratio) return color
  let t = 0
  let cur = color
  while (t < 0.85) {
    t = Math.round((t + 0.05) * 100) / 100
    const next = mix(color, '#000000', t)
    if (!next) return color
    cur = next
    if (contrast(cur, bg) >= ratio) return cur
  }
  return cur
}

/** Historical dark-chrome literals. The dark branch MUST keep these values. */
export const SEMANTIC = {
  muted: '#8a8a8a',
  success: '#3fb950',
  danger: '#f85149',
  warning: '#d29922',
  info: '#58a6ff',
  surfaceRaised: 'rgba(24, 26, 31, 0.85)',
  hover: 'rgba(255, 255, 255, 0.08)',
  borderStrong: 'rgba(255, 255, 255, 0.16)',
  scrollbar: 'rgba(125, 145, 170, 0.5)',
  scrollbarActive: 'rgba(150, 172, 200, 0.7)',
  shadow: 'rgba(0, 0, 0, 0.45)',
  focusRing: 'rgba(59, 142, 234, 0.2)'
} as const

/** Values for --ot-* variables (camelCase keys; chrome.ts converts them to
 *  kebab-case, so `textMuted` lands as `--ot-text-muted`). */
export function semanticVars(colors: ThemeLike, light: boolean): Record<string, string> {
  const bg = colors.background
  const fg = colors.foreground
  if (!light) {
    return {
      text: fg,
      textSecondary: mix(bg, fg, 0.78) ?? fg,
      textMuted: SEMANTIC.muted,
      surface: mix(bg, fg, 0.05) ?? bg,
      surfaceRaised: SEMANTIC.surfaceRaised,
      hover: SEMANTIC.hover,
      border: mix(bg, fg, 0.16) ?? bg,
      borderStrong: SEMANTIC.borderStrong,
      success: SEMANTIC.success,
      successFg: SEMANTIC.success,
      danger: SEMANTIC.danger,
      dangerFg: SEMANTIC.danger,
      warning: SEMANTIC.warning,
      warningFg: SEMANTIC.warning,
      info: SEMANTIC.info,
      infoFg: SEMANTIC.info,
      scrollbar: SEMANTIC.scrollbar,
      scrollbarActive: SEMANTIC.scrollbarActive,
      shadow: SEMANTIC.shadow,
      focusRing: SEMANTIC.focusRing,
      colorScheme: 'dark'
    }
  }
  return {
    text: darkenToRatio(fg, bg, 7),
    textSecondary: darkenToRatio(mix(bg, fg, 0.75) ?? fg, bg, 4.5),
    textMuted: darkenToRatio(SEMANTIC.muted, bg, 4.5),
    surface: mix(bg, fg, 0.04) ?? bg,
    surfaceRaised: mix(bg, '#000000', 0.045) ?? bg,
    hover: 'rgba(0, 0, 0, 0.06)',
    border: mix(bg, '#000000', 0.14) ?? bg,
    borderStrong: 'rgba(0, 0, 0, 0.22)',
    success: darkenToRatio(SEMANTIC.success, bg, 3),
    successFg: darkenToRatio(SEMANTIC.success, bg, 4.5),
    danger: darkenToRatio(SEMANTIC.danger, bg, 3),
    dangerFg: darkenToRatio(SEMANTIC.danger, bg, 4.5),
    warning: darkenToRatio(SEMANTIC.warning, bg, 3),
    warningFg: darkenToRatio(SEMANTIC.warning, bg, 4.5),
    info: darkenToRatio(SEMANTIC.info, bg, 3),
    infoFg: darkenToRatio(SEMANTIC.info, bg, 4.5),
    scrollbar: 'rgba(0, 0, 0, 0.28)',
    scrollbarActive: 'rgba(0, 0, 0, 0.45)',
    shadow: 'rgba(0, 0, 0, 0.15)',
    focusRing: SEMANTIC.focusRing,
    colorScheme: 'light'
  }
}

/** Final CSS custom property name for a semanticVars() key. Custom property
 *  names are case-sensitive, so this kebab conversion is the only thing tying
 *  the camelCase keys to the --ot-* names the stylesheets read — a miss leaves
 *  the variable unset and the element falls back to the dark :root literal.
 *  Exported so chrome.ts and tests/ot-var-names.mjs share one implementation. */
export function cssVarName(key: string): string {
  if (key === 'colorScheme') return 'color-scheme'
  return `--ot-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`
}

/** semanticVars() keyed by their final CSS custom property names. */
export function semanticCssVars(colors: ThemeLike, light: boolean): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(semanticVars(colors, light))) out[cssVarName(key)] = value
  return out
}
