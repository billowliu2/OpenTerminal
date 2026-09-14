import type { PtyDataEvent, PtyExitEvent } from '@shared/ipc'

/**
 * Single shared PTY stream listener. Every pane used to register its own
 * window.api.onPtyData/onPtyExit listener, so each output chunk woke N
 * listeners (N = pane count) and N-1 of them discarded it after an id
 * compare. With many terminals under heavy output that per-chunk fan-out is
 * pure overhead. Here one IPC listener dispatches through a Map keyed by
 * sessionId: one lookup per chunk, and only the owning pane runs.
 */

type DataHandler = (data: string) => void
type ExitHandler = (exitCode: number) => void

const dataHandlers = new Map<string, DataHandler>()
const exitHandlers = new Map<string, ExitHandler>()
let bound = false

function ensureBound(): void {
  if (bound) return
  bound = true
  window.api.onPtyData((e: PtyDataEvent) => {
    dataHandlers.get(e.id)?.(e.data)
  })
  window.api.onPtyExit((e: PtyExitEvent) => {
    exitHandlers.get(e.id)?.(e.exitCode)
  })
}

/** Subscribe to one session's output. Returns the unsubscribe function. */
export function subscribePtyData(id: string, cb: DataHandler): () => void {
  ensureBound()
  dataHandlers.set(id, cb)
  return () => {
    // A rebind (template apply) may have replaced the handler already; only
    // delete when this subscription is still the registered one.
    if (dataHandlers.get(id) === cb) dataHandlers.delete(id)
  }
}

/** Subscribe to one session's exit. Returns the unsubscribe function. */
export function subscribePtyExit(id: string, cb: ExitHandler): () => void {
  ensureBound()
  exitHandlers.set(id, cb)
  return () => {
    if (exitHandlers.get(id) === cb) exitHandlers.delete(id)
  }
}
