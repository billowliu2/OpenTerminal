import { create } from 'zustand'

/** One open terminal session eligible to be a broadcast target. */
export interface BroadcastSession {
  /** pty / ssh session id (also the dockview panel id) */
  id: string
  title: string
  isSsh: boolean
}

export interface BroadcastState {
  /** master switch; only settable while there are >= 2 open sessions */
  enabled: boolean
  /** session ids receiving broadcast input */
  targets: Set<string>
  /** open terminal sessions, registration order preserved */
  sessions: BroadcastSession[]
  /** register a session as broadcast-eligible (idempotent, keeps it fresh) */
  registerSession: (session: BroadcastSession) => void
  /** remove a session; if it was a target, prune it (may auto-disable <2 targets) */
  unregisterSession: (id: string) => void
  /** add/remove one target; never lets the set drop below 2 while enabled */
  toggleTarget: (id: string) => void
  /** turn broadcast on/off */
  setEnabled: (enabled: boolean) => void
}

/**
 * Resolve the set of sessions a keypress should be written to.
 * - Broadcast disabled OR the originating session is not a target → the
 *   session alone (existing single-write behaviour; the origin's own fallback
 *   echo is handled by individual pty instances).
 * - Broadcast enabled and origin is a target → every target session.
 */
export function broadcastFanOut(originId: string, targets: Set<string>, enabled: boolean): string[] {
  if (!enabled) return [originId]
  if (!targets.has(originId)) return [originId]
  return [...targets]
}

function pruneOnTargetLoss(enabled: boolean, nextTargets: Set<string>): { enabled: boolean; targets: Set<string> } {
  if (nextTargets.size < 2) return { enabled: false, targets: new Set() }
  return { enabled, targets: nextTargets }
}

export const useBroadcastStore = create<BroadcastState>((set) => ({
  enabled: false,
  targets: new Set(),
  sessions: [],

  registerSession: (session) =>
    set((state) => {
      const exists = state.sessions.some((s) => s.id === session.id)
      if (exists) {
        // keep title/isSsh fresh (e.g. template apply retitles a panel)
        const sessions = state.sessions.map((s) => (s.id === session.id ? session : s))
        const targets = new Set(state.targets)
        return { sessions, targets }
      }
      return { sessions: [...state.sessions, session] }
    }),

  unregisterSession: (id) =>
    set((state) => {
      const sessions = state.sessions.filter((s) => s.id !== id)
      if (!state.targets.has(id)) return { sessions }
      const targets = new Set(state.targets)
      targets.delete(id)
      return { sessions, ...pruneOnTargetLoss(state.enabled, targets) }
    }),

  toggleTarget: (id) =>
    set((state) => {
      const targets = new Set(state.targets)
      if (targets.has(id)) {
        targets.delete(id)
        return pruneOnTargetLoss(state.enabled, targets)
      }
      targets.add(id)
      // requires >= 2 targets to become/become-enabled
      if (targets.size < 2) return { enabled: false, targets }
      return { enabled: true, targets }
    }),

  setEnabled: (enabled) =>
    set((state) => {
      if (enabled && state.targets.size < 2) return { enabled: state.enabled }
      return { enabled }
    })
}))

/** Write `data` to the full broadcast fan-out for an originating session. */
export function writeBroadcast(originId: string, data: string): void {
  const { targets, enabled, sessions } = useBroadcastStore.getState()
  const out = broadcastFanOut(originId, targets, enabled)
  for (const id of out) {
    // never write to a session that is no longer open
    if (sessions.some((s) => s.id === id)) window.api.writePty(id, data)
  }
}