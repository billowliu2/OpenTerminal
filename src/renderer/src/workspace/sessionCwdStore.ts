/**
 * Last known working directory per pty session.
 *
 * Filled by <TerminalView> (typed `cd` commands and shell OSC reports) and read
 * by the workspace when it builds a session snapshot, so a restored pane opens
 * in the directory it was left in. Keyed by sessionId, which is regenerated on
 * every launch — the snapshot maps panelId → cwd, and this map is the live
 * lookup behind it.
 */

const cwds = new Map<string, string>()
const listeners = new Set<() => void>()

export function setSessionCwd(sessionId: string, cwd: string): void {
  if (!sessionId || !cwd) return
  if (cwds.get(sessionId) === cwd) return
  cwds.set(sessionId, cwd)
  for (const listener of listeners) listener()
}

export function getSessionCwd(sessionId: string | undefined): string | undefined {
  return sessionId ? cwds.get(sessionId) : undefined
}

export function forgetSessionCwd(sessionId: string | undefined): void {
  if (!sessionId) return
  if (cwds.delete(sessionId)) {
    for (const listener of listeners) listener()
  }
}

/** Subscribe to any change; returns an unsubscribe function. */
export function onSessionCwdChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
