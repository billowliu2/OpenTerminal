import type { RuleStat } from './highlightEngine'

/**
 * Live per-rule highlight counters, read by the settings page.
 *
 * The engine fills these only when a sink is attached, and `TerminalView`
 * attaches one only while `settings.terminal.highlightStats` is on — so the
 * default write path pays nothing. Totals are cumulative since the last reset;
 * TerminalView publishes on a timer (not per chunk), because a busy terminal
 * would otherwise re-render the settings page thousands of times a second.
 */

let totals: Map<string, RuleStat> = new Map()
let updatedAt = 0
const listeners = new Set<() => void>()

export interface HighlightStatsSnapshot {
  rules: Map<string, RuleStat>
  /** epoch ms of the last publish; the UI re-renders on change */
  updatedAt: number
}

export function getHighlightStats(): HighlightStatsSnapshot {
  return { rules: totals, updatedAt }
}

/** Hand the accumulated counters to the UI (TerminalView owns the map). */
export function publishHighlightStats(next: Map<string, RuleStat>): void {
  totals = next
  updatedAt = Date.now()
  for (const listener of listeners) listener()
}

export function resetHighlightStats(): void {
  publishHighlightStats(new Map())
}

export function subscribeHighlightStats(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
