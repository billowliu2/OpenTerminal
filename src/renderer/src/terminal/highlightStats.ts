import type { RuleStat } from './highlightEngine'

/**
 * Live per-rule highlight counters, read by the settings page.
 *
 * The engine fills a pane's own map only when a sink is attached, and
 * `TerminalView` attaches one only while `settings.terminal.highlightStats` is
 * on — so the default write path pays nothing. Totals are cumulative since the
 * last reset, and panes publish on a timer (not per chunk), because a busy
 * terminal would otherwise re-render the settings page thousands of times a
 * second.
 *
 * A publish *registers* the pane rather than overwriting one shared slot: with
 * a single slot, every open pane took turns winning it and the settings page
 * showed whichever published last instead of a total. Readers get the merge
 * across all panes (hits and ms summed per rule id), so a pane must unregister
 * when it goes away — otherwise a closed pane would inflate that merge forever.
 */

/** Opaque per-pane id → that pane's live sink map (kept by reference). */
const panes = new Map<string, Map<string, RuleStat>>()
let merged: Map<string, RuleStat> = new Map()
let updatedAt = 0
const listeners = new Set<() => void>()

export interface HighlightStatsSnapshot {
  /** merged across every registered pane; a fresh map per publish */
  rules: Map<string, RuleStat>
  /** epoch ms of the last publish; the UI re-renders on change */
  updatedAt: number
}

/**
 * Fold every registered pane into one map. The accumulator objects are new, so
 * nothing here can write into a pane's own counters. A single registered pane
 * yields exactly its own numbers — the merge is a no-op with one pane.
 */
function recompute(): void {
  const next = new Map<string, RuleStat>()
  for (const pane of panes.values()) {
    for (const [ruleId, stat] of pane) {
      const acc = next.get(ruleId)
      if (acc === undefined) {
        next.set(ruleId, { hits: stat.hits, ms: stat.ms })
      } else {
        acc.hits += stat.hits
        acc.ms += stat.ms
      }
    }
  }
  merged = next
  updatedAt = Date.now()
  for (const listener of listeners) listener()
}

export function getHighlightStats(): HighlightStatsSnapshot {
  return { rules: merged, updatedAt }
}

/**
 * Register (or refresh) one pane's counters and re-publish the merge.
 *
 * `paneId` has to stay stable for the pane's lifetime: the map is held by
 * reference, so re-publishing the same id simply re-reads that pane's numbers.
 */
export function publishHighlightStats(paneId: string, stats: Map<string, RuleStat>): void {
  panes.set(paneId, stats)
  recompute()
}

/** Drop a pane's counters — called when its `TerminalView` unmounts. */
export function unregisterHighlightStats(paneId: string): void {
  if (!panes.delete(paneId)) return
  recompute()
}

/**
 * Zero every registered pane. Clearing the panes' own maps (not just the
 * merge) is what makes a reset stick: the live panes keep accumulating into
 * those same maps, so a merge-only reset would be undone by the next publish.
 */
export function resetHighlightStats(): void {
  for (const pane of panes.values()) pane.clear()
  recompute()
}

export function subscribeHighlightStats(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
