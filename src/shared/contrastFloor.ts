/**
 * The contrast floor the terminal hands to the renderer.
 *
 * `minimumContrastRatio` (xterm) is the minimum contrast ratio between a
 * cell's text and its background. The renderer adjusts the foreground colour
 * of a cell only when the pair it would draw falls below the floor, so the
 * theme's own colours survive — only unreadable pairs are repaired.
 *
 * Why this exists: some full-screen programs paint their own light background
 * (a message card, a selection panel) and leave the foreground at the
 * terminal's default. On a dark theme that default is near-white, so the card
 * renders as light text on a light background — invisible. The Doubao CLI is
 * one such program: it decides the card colour from the *host* terminal's
 * palette, which under ConPTY is the legacy Windows palette (white =
 * #f0f0f0) unless the host configures the pseudo console — something
 * node-pty cannot reach. The floor repairs the result instead.
 *
 * Pure function; the renderer wiring lives in TerminalView and the settings
 * store clamps the persisted value with it.
 * Table-tested by tests/contrast-floor.mjs.
 */

/** Lowest ratio the renderer accepts: 1 = no enforcement at all. */
export const CONTRAST_FLOOR_MIN = 1

/** Highest ratio the renderer accepts (xterm clamps to 21). */
export const CONTRAST_FLOOR_MAX = 21

/** The default floor: WCAG AA for body text. */
export const CONTRAST_FLOOR_DEFAULT = 4.5

/**
 * A background image keeps its own floor: xterm reads a transparent
 * background as black, so text over a wallpaper has to clear AA against black
 * no matter what the user chose.
 */
export const BACKGROUND_IMAGE_FLOOR = 4.5

/**
 * The floor to apply.
 *
 * @param ratio the user's setting; anything unusable falls back to the default
 * @param hasBackgroundImage whether a background image is in use
 */
export function contrastFloor(ratio: number, hasBackgroundImage: boolean): number {
  const wanted =
    typeof ratio === 'number' && Number.isFinite(ratio) ? ratio : CONTRAST_FLOOR_DEFAULT
  const clamped = Math.min(CONTRAST_FLOOR_MAX, Math.max(CONTRAST_FLOOR_MIN, wanted))
  // xterm rounds the ratio to one decimal — match it so the value we compute
  // is the value it stores.
  const rounded = Math.round(clamped * 10) / 10
  return hasBackgroundImage ? Math.max(rounded, BACKGROUND_IMAGE_FLOOR) : rounded
}
