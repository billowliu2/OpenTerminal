import { hexToRgb } from '../terminal/highlightEngine'
import type { HighlightRule } from '@shared/settings'
import type { TerminalTheme, ThemeColors } from '@shared/theme'

/**
 * Optional "follow the theme" colour mapping for highlight rules.
 *
 * Rules ship with hand-picked hex colours that read on any theme, but a user on
 * Solarized or Gruvbox usually wants highlighting drawn from *their* palette.
 * The mapping buckets a colour by hue instead of picking the nearest swatch, so
 * the intent survives: a success green stays a green, an error red stays a red.
 * Brightness selects the normal or bright palette entry, which is what keeps a
 * two-green value band (50–80% light green vs 80%+ green) distinguishable.
 *
 * Muted colours (grey-ish, like the 1xx status grey) are left untouched — there
 * is no hue to follow, and the palette has no neutral that means "quieter".
 */

/** ANSI palette entries a highlight colour can land on. */
type PaletteName = 'red' | 'yellow' | 'green' | 'cyan' | 'blue' | 'magenta'

export interface PaletteMatch {
  name: PaletteName
  bright: boolean
}

/** Below this saturation a colour counts as neutral and keeps its own value. */
const NEUTRAL_SATURATION = 0.15
/** Above this lightness the "bright" palette entry is used. */
const BRIGHT_LIGHTNESS = 0.6

/** Bucket a colour by hue/brightness, or `null` for neutrals. */
export function paletteMatch(hex: string): PaletteMatch | null {
  const { r, g, b } = hexToRgb(hex)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  if (max === 0 || (max - min) / max < NEUTRAL_SATURATION) return null

  const lightness = (max + min) / 2 / 255
  const delta = max - min
  let hue: number
  if (max === r) hue = ((g - b) / delta) % 6
  else if (max === g) hue = (b - r) / delta + 2
  else hue = (r - g) / delta + 4
  hue = (hue * 60 + 360) % 360

  const name: PaletteName =
    hue < 25 || hue >= 335
      ? 'red'
      : hue < 70
        ? 'yellow'
        : hue < 165
          ? 'green'
          : hue < 200
            ? 'cyan'
            : hue < 265
              ? 'blue'
              : 'magenta'

  return { name, bright: lightness >= BRIGHT_LIGHTNESS }
}

/** The theme's colour for a rule colour, or the rule colour when it has no hue. */
export function themeColorFor(hex: string, theme: TerminalTheme): string {
  const match = paletteMatch(hex)
  if (match === null) return hex
  const key = (
    match.bright ? `bright${match.name[0].toUpperCase()}${match.name.slice(1)}` : match.name
  ) as keyof ThemeColors
  const color = theme.colors[key]
  return typeof color === 'string' && color !== '' ? color : hex
}

/**
 * Rewrite a rule set onto the theme's palette. Backgrounds are left alone on
 * purpose: they are a block behind the text, not a semantic signal, and mapping
 * them to a palette *foreground* colour would invert their meaning.
 */
export function applyThemeColors(rules: HighlightRule[], theme: TerminalTheme): HighlightRule[] {
  return rules.map((rule) => ({
    ...rule,
    color: { fg: themeColorFor(rule.color.fg, theme), ...(rule.color.bg ? { bg: rule.color.bg } : {}) },
    ...(rule.bands
      ? { bands: rule.bands.map((band) => ({ ...band, fg: themeColorFor(band.fg, theme) })) }
      : {})
  }))
}
