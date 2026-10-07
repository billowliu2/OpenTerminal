/**
 * Accelerators the app binds itself, shared by the two places that must agree
 * on them:
 *
 *  - the settings recorder (`SettingsTabs.tsx`) refuses to SAVE such a chord, so
 *    a global registration never shadows the in-app action;
 *  - `applyGlobalShortcut` (main) refuses to REGISTER one. The recorder only
 *    guards values entered after it existed — a shortcut persisted by an older
 *    build still arrives there, and a globalShortcut registration intercepts the
 *    key at the OS level even while the window is focused.
 *
 * Both sides used to keep their own table and only the renderer's was covered by
 * a test; keeping the decision here (pure, no imports) makes the two guards
 * provably identical and table-testable under plain Node.
 */

/**
 * Modifier aliases, folded to Electron's canonical spelling. `cmdorctrl`,
 * `commandorctrl` and `commandorcontrol` all collapse to `control`: the only
 * platform this app is packaged for is Windows, where CommandOrControl resolves
 * to Control, and a legacy value saved with the portable spelling would
 * otherwise slip past the reserved check into a real registration.
 */
function canonicalPart(part: string): string {
  const p = part.trim().toLowerCase()
  if (p === 'ctrl') return 'control'
  if (p === 'cmdorctrl' || p === 'commandorctrl' || p === 'commandorcontrol') return 'control'
  return p
}

/** Split an accelerator into its canonical parts (`Ctrl+L` -> `['control','l']`). */
export function acceleratorParts(accelerator: string): string[] {
  return accelerator.split('+').map(canonicalPart)
}

/**
 * Whole chords the app owns outright, matched exactly (modifier set included).
 * Ctrl+L is the panic lock, captured in main's before-input-event: a global
 * registration intercepts the key at the OS level even while this window is
 * focused, so binding it would silently disable the lock shortcut.
 */
const RESERVED_EXACT = new Set(['control+l'])

/**
 * Keys this app binds while Control is held: font size (Ctrl+=/-/0, main.tsx)
 * and tab cycling (Ctrl+PgUp/PgDn, Workspace). Neither handler looks at the
 * other modifiers, so any Control combo on one of these keys would shadow the
 * in-app action — the recorder refuses it, and the main process must not
 * register a legacy value that has the same effect.
 */
const RESERVED_CONTROL_KEYS = new Set(['=', '-', '0', 'pageup', 'pagedown'])

/**
 * True when `accelerator` collides with a shortcut the app already answers
 * itself (e.g. `Control+Shift+=`, `Ctrl+L`).
 */
export function isReservedAccelerator(accelerator: string): boolean {
  const parts = acceleratorParts(accelerator)
  if (RESERVED_EXACT.has(parts.join('+'))) return true
  return parts.includes('control') && RESERVED_CONTROL_KEYS.has(parts[parts.length - 1])
}
