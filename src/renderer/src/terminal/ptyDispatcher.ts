import type { PtyDataEvent, PtyExitEvent } from '@shared/ipc'

/**
 * Single shared PTY stream listener. Every pane used to register its own
 * window.api.onPtyData/onPtyExit listener, so each output chunk woke N
 * listeners (N = pane count) and N-1 of them discarded it after an id
 * compare. With many terminals under heavy output that per-chunk fan-out is
 * pure overhead. Here one IPC listener dispatches through a Map keyed by
 * sessionId: one lookup per chunk, and only the owning session's panes run.
 *
 * The per-id value is a Set, not a single handler: an SSH split deliberately
 * binds two panes to the same sessionId, so the second pane must not steal
 * (and its teardown must not revoke) the first pane's stream.
 */

type DataHandler = (data: string) => void
type ExitHandler = (exitCode: number) => void

const dataHandlers = new Map<string, Set<DataHandler>>()
const exitHandlers = new Map<string, Set<ExitHandler>>()
let bound = false

function ensureBound(): void {
  if (bound) return
  bound = true
  window.api.onPtyData((e: PtyDataEvent) => {
    dataHandlers.get(e.id)?.forEach((cb) => cb(e.data))
  })
  window.api.onPtyExit((e: PtyExitEvent) => {
    exitHandlers.get(e.id)?.forEach((cb) => cb(e.exitCode))
  })
}

/** Subscribe to one session's output. Returns the unsubscribe function. */
export function subscribePtyData(id: string, cb: DataHandler): () => void {
  ensureBound()
  let set = dataHandlers.get(id)
  if (!set) {
    set = new Set()
    dataHandlers.set(id, set)
  }
  set.add(cb)
  return () => {
    const set = dataHandlers.get(id)
    if (!set) return
    set.delete(cb)
    if (set.size === 0) dataHandlers.delete(id)
  }
}

/** Subscribe to one session's exit. Returns the unsubscribe function. */
export function subscribePtyExit(id: string, cb: ExitHandler): () => void {
  ensureBound()
  let set = exitHandlers.get(id)
  if (!set) {
    set = new Set()
    exitHandlers.set(id, set)
  }
  set.add(cb)
  return () => {
    const set = exitHandlers.get(id)
    if (!set) return
    set.delete(cb)
    if (set.size === 0) exitHandlers.delete(id)
  }
}
