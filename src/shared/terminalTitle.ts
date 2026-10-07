/**
 * Auto-generated local-terminal tab titles ("终端 3", "Terminal 3", …).
 *
 * A tab title is stored DISPLAY text, not data: dockview serializes it into
 * layout templates, the workspace writes it into the session snapshot, and the
 * broadcast registry keeps it. It used to be produced from the pattern of the
 * *active* language and read back through that same pattern, so a title written
 * before a language switch was neither countable (numbering restarted and
 * produced duplicates) nor re-renderable (it stayed in the old language).
 *
 * The two directions are therefore asymmetric:
 *   - resolution runs over EVERY language's pattern, so an auto title is
 *     recognized no matter which language wrote it;
 *   - rendering uses the active language, so a switch re-renders it in place.
 *
 * A title matching no pattern was typed by the user and is never touched.
 *
 * Pure module (no Electron, no React, no browser surface) so plain Node can
 * table-test it; the same shape as `reservedAccelerators.ts`.
 */

import { LANGUAGES, t, tFor } from './i18n'

const TITLE_KEY = 'workspace.tab.terminalTitle'

/** Sentinel for "the number goes here", so the rendered pattern can be split
 *  into its literal head and tail. Cannot occur in a dictionary. */
const MARK = '\u0000'

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Split a rendered pattern into the text before and after the number.
 * `undefined` when the dictionary has no `{n}` at all (a missing key falls back
 * to the key itself) or more than one — such a language cannot title a pane.
 */
function splitPattern(rendered: string): { head: string; tail: string } | undefined {
  const parts = rendered.split(MARK)
  if (parts.length !== 2) return undefined
  return { head: parts[0], tail: parts[1] }
}

/**
 * Every language's pattern, compiled once: the dictionaries are static for the
 * process's lifetime. Duplicates are dropped — a dictionary missing the key
 * falls back to zh-CN and would otherwise be matched twice.
 */
const PATTERNS: RegExp[] = (() => {
  const out: RegExp[] = []
  const seen = new Set<string>()
  for (const { value } of LANGUAGES) {
    const parts = splitPattern(tFor(value, TITLE_KEY, { n: MARK }))
    if (!parts) continue
    const key = `${parts.head}\u0001${parts.tail}`
    if (seen.has(key)) continue
    seen.add(key)
    // Both literals are anchored and matched exactly: "终端 3 号" and
    // "终端机 3" are user titles, not auto ones. The digits exclude a leading
    // zero — the app renders `String(n)` — so "Terminal 007" stays a user
    // title instead of being renamed to "Terminal 7".
    out.push(new RegExp(`^${escapeRegExp(parts.head)}([1-9]\\d*)${escapeRegExp(parts.tail)}$`))
  }
  return out
})()

/**
 * The number an auto title carries, in whichever language wrote it, or
 * `undefined` when the title is not an auto title.
 */
export function autoTerminalTitleNumber(title: string): number | undefined {
  if (!title) return undefined
  for (const matcher of PATTERNS) {
    const found = matcher.exec(title)
    if (found) return Number(found[1])
  }
  return undefined
}

/** The auto title for `n` in the active language. */
export function renderTerminalTitle(n: number): string {
  return t(TITLE_KEY, { n })
}

/**
 * The auto title for the lowest free number among `existing`, in the active
 * language. Numbers occupied in ANY language count as used, so a pane that
 * still carries an old-language title keeps its number reserved.
 *
 * Closing a pane frees its number for the next new terminal, and a session
 * restore can no longer leave the numbering behind (the old in-memory counter
 * restarted at zero on launch and produced duplicate titles).
 */
export function nextTerminalTitle(existing: Iterable<string | undefined>): string {
  const used = new Set<number>()
  for (const title of existing) {
    if (!title) continue
    const n = autoTerminalTitleNumber(title)
    if (n !== undefined) used.add(n)
  }
  let n = 1
  while (used.has(n)) n++
  return renderTerminalTitle(n)
}

/** Just enough of a dockview panel for {@link retitleAutoTitles} — the real
 *  `IDockviewPanel` satisfies this structurally, so no adapter is needed. */
export interface RetitlePanel {
  readonly title: string | undefined
  setTitle(title: string): void
}

/**
 * Re-render `panels`' auto titles in the active language, keeping each number;
 * returns how many were rewritten.
 *
 * Called on a language switch (the rest of the UI re-renders itself) and after
 * a layout/snapshot restore (which brings back titles stored under some older
 * language). A panel whose title matches no language's pattern was named by the
 * user and is left exactly as it is; one whose title already reads correctly is
 * skipped, so this is safe to run on every settings echo.
 *
 * The caller decides which panels are eligible: an SSH pane is titled with the
 * connection name the user typed, so a connection called "Terminal 3" must not
 * be renamed behind their back.
 */
export function retitleAutoTitles(panels: Iterable<RetitlePanel>): number {
  let changed = 0
  for (const panel of panels) {
    const n = autoTerminalTitleNumber(panel.title ?? '')
    if (n === undefined) continue
    const next = renderTerminalTitle(n)
    if (next === panel.title) continue
    panel.setTitle(next)
    changed++
  }
  return changed
}
