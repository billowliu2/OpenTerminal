/**
 * Lock-screen keyboard classification, kept free of Electron imports so the
 * decision logic can be table-tested under plain Node (tests/lock-shortcuts.mjs).
 * `Electron.Input` satisfies this shape structurally.
 */

export interface LockInputEvent {
  key: string
  control: boolean
  shift: boolean
  alt: boolean
  meta: boolean
  isAutoRepeat?: boolean
}

/**
 * Accelerators that must not reach the page while the lock screen is up.
 *
 * The overlay is a DOM layer inside the window, so everything the browser
 * process handles on its own passes straight through it: reloading the renderer
 * runs Workspace's beforeunload and kills every local/SSH session behind the
 * overlay, and the zoom / DevTools shortcuts would let the locked screen be
 * resized or read. These chords come from Electron's default application menu,
 * whose keys are matched before any renderer code runs (the menu itself is
 * removed while locked — see lockMenu.ts — so its mouse-clickable items cannot
 * be reached either).
 *
 * Matching is on `input.key` rather than `input.code`: the key is what the
 * layout actually produces (Ctrl+Shift+= arrives as '+', Ctrl+Shift+- as '_'),
 * while the code depends on the physical key.
 */
export function isLockBlockedShortcut(input: LockInputEvent): boolean {
  const key = input.key.toLowerCase()
  if (key === 'f5') return true
  if (!input.control) return false
  if (key === 'r') return true
  // Zoom: in, out and reset, in both their plain and Shift-shifted spellings.
  if (key === '=' || key === '+' || key === '-' || key === '_' || key === '0') return true
  // DevTools. Shift is required so that plain Ctrl+C (copy) keeps working.
  return input.shift && (key === 'i' || key === 'j' || key === 'c')
}

/**
 * The panic lock chord: exactly Ctrl+L, no other modifier. Shift is excluded
 * because Ctrl+Shift+L is the switch-to-English chord on Chinese and Japanese
 * IMEs; Alt is excluded because AltGr arrives as Ctrl+Alt on most European
 * layouts. A chord that isn't exactly this must keep its original meaning.
 */
export function isPanicLockChord(input: LockInputEvent): boolean {
  return (
    input.control &&
    !input.shift &&
    !input.alt &&
    !input.meta &&
    input.key.toLowerCase() === 'l'
  )
}
