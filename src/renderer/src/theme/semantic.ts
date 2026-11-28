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
  if (typeof color !== 'string') return null
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

/** Lighten `color` toward white in 0.05 steps until contrast vs `bg` >= ratio.
 *  The mirror of darkenToRatio: a colour that is too DARK for a dark surface
 *  (a near-black rule colour on the settings panel) has to be lifted, not
 *  pressed further into the background. */
export function lightenToRatio(color: string, bg: string, ratio: number): string {
  if (contrast(color, bg) >= ratio) return color
  let t = 0
  let cur = color
  while (t < 0.85) {
    t = Math.round((t + 0.05) * 100) / 100
    const next = mix(color, '#ffffff', t)
    if (!next) return color
    cur = next
    if (contrast(cur, bg) >= ratio) return cur
  }
  return cur
}

/**
 * Bring `color` to at least `ratio` contrast against `bg`, whichever way that
 * has to go: a light surface needs the colour pressed DOWN, a dark surface
 * needs it lifted UP. Used wherever a colour chosen for one theme is shown on
 * another surface (the highlight rules table previews its rule colours on the
 * settings panel, whose own background follows the active theme).
 */
export function ensureContrast(color: string, bg: string, ratio: number): string {
  if (contrast(color, bg) >= ratio) return color
  return isLightTheme(bg)
    ? darkenToRatio(color, bg, ratio)
    : lightenToRatio(color, bg, ratio)
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

/**
 * antd's primary fill. The app PINS it (main.tsx sets the antd token
 * `colorPrimary` to this exact value) so the colour of a label drawn on that
 * fill can be DERIVED against the real fill instead of guessed.
 *
 * It is one step darker than antd's own default (#1677ff): the default only
 * reaches 4.10:1 with a white label, while this reaches 5.37:1. The visual
 * delta is imperceptible, and every primary button in the app gains the
 * contrast.
 */
export const PRIMARY_COLOR = '#0f66d8'

/**
 * The readable label colour for text drawn on PRIMARY_COLOR.
 *
 * White is used whenever it clears 4.5:1 against the fill; otherwise the dark
 * ink is. The chrome-background token `--tab-accent-fg` must NOT be used for
 * this: it is derived against the CHROME BACKGROUND, and reusing it as a
 * label on the primary fill measured 1.51:1 (light chrome) / 1.92:1 (dark).
 */
export function onPrimaryLabel(): string {
  return contrast('#ffffff', PRIMARY_COLOR) >= 4.5 ? '#ffffff' : '#101418'
}

/** The CSS custom property names semanticVars() emits. There is exactly ONE
 *  naming system: the keys ARE the final names, so a typo is a type error at
 *  the read site instead of a silently unset variable (custom property names
 *  are case-sensitive — a camelCase key would never match `var(--ot-*)` and the
 *  element would fall back to the dark :root literal). tests/ot-var-names.mjs
 *  asserts every key matches /^--ot-[a-z0-9-]+$/ so camelCase cannot creep
 *  back in. Keep this union and the two branches in semanticVars() in sync. */
export type OtVarName =
  | '--ot-text'
  | '--ot-text-secondary'
  | '--ot-text-muted'
  | '--ot-surface'
  | '--ot-surface-raised'
  | '--ot-hover'
  | '--ot-border'
  | '--ot-border-strong'
  | '--ot-success'
  | '--ot-success-fg'
  | '--ot-danger'
  | '--ot-danger-fg'
  | '--ot-warning'
  | '--ot-warning-fg'
  | '--ot-info'
  | '--ot-info-fg'
  | '--ot-scrollbar'
  | '--ot-scrollbar-active'
  | '--ot-shadow'
  | '--ot-focus-ring'

/** semanticVars() result. `color-scheme` is not an --ot-* variable but rides
 *  along so native scrollbars and form controls follow the same switch. */
export type SemanticVars = Record<OtVarName | 'color-scheme', string>

/** Values for the --ot-* variables, keyed by their final CSS custom property
 *  names (chrome.ts writes them straight onto <html>). */
export function semanticVars(colors: ThemeLike, light: boolean): SemanticVars {
  const bg = colors.background
  const fg = colors.foreground
  if (!light) {
    return {
      '--ot-text': fg,
      '--ot-text-secondary': mix(bg, fg, 0.78) ?? fg,
      '--ot-text-muted': SEMANTIC.muted,
      '--ot-surface': mix(bg, fg, 0.05) ?? bg,
      '--ot-surface-raised': SEMANTIC.surfaceRaised,
      '--ot-hover': SEMANTIC.hover,
      '--ot-border': mix(bg, fg, 0.16) ?? bg,
      '--ot-border-strong': SEMANTIC.borderStrong,
      '--ot-success': SEMANTIC.success,
      '--ot-success-fg': SEMANTIC.success,
      '--ot-danger': SEMANTIC.danger,
      '--ot-danger-fg': SEMANTIC.danger,
      '--ot-warning': SEMANTIC.warning,
      '--ot-warning-fg': SEMANTIC.warning,
      '--ot-info': SEMANTIC.info,
      '--ot-info-fg': SEMANTIC.info,
      '--ot-scrollbar': SEMANTIC.scrollbar,
      '--ot-scrollbar-active': SEMANTIC.scrollbarActive,
      '--ot-shadow': SEMANTIC.shadow,
      '--ot-focus-ring': SEMANTIC.focusRing,
      'color-scheme': 'dark'
    }
  }
  return {
    '--ot-text': darkenToRatio(fg, bg, 7),
    '--ot-text-secondary': darkenToRatio(mix(bg, fg, 0.75) ?? fg, bg, 4.5),
    '--ot-text-muted': darkenToRatio(SEMANTIC.muted, bg, 4.5),
    '--ot-surface': mix(bg, fg, 0.04) ?? bg,
    '--ot-surface-raised': mix(bg, '#000000', 0.045) ?? bg,
    '--ot-hover': 'rgba(0, 0, 0, 0.06)',
    '--ot-border': mix(bg, '#000000', 0.14) ?? bg,
    '--ot-border-strong': 'rgba(0, 0, 0, 0.22)',
    '--ot-success': darkenToRatio(SEMANTIC.success, bg, 3),
    '--ot-success-fg': darkenToRatio(SEMANTIC.success, bg, 4.5),
    '--ot-danger': darkenToRatio(SEMANTIC.danger, bg, 3),
    '--ot-danger-fg': darkenToRatio(SEMANTIC.danger, bg, 4.5),
    '--ot-warning': darkenToRatio(SEMANTIC.warning, bg, 3),
    '--ot-warning-fg': darkenToRatio(SEMANTIC.warning, bg, 4.5),
    '--ot-info': darkenToRatio(SEMANTIC.info, bg, 3),
    '--ot-info-fg': darkenToRatio(SEMANTIC.info, bg, 4.5),
    '--ot-scrollbar': 'rgba(0, 0, 0, 0.28)',
    '--ot-scrollbar-active': 'rgba(0, 0, 0, 0.45)',
    '--ot-shadow': 'rgba(0, 0, 0, 0.15)',
    '--ot-focus-ring': SEMANTIC.focusRing,
    'color-scheme': 'light'
  }
}
