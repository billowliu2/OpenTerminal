import { create } from 'zustand'

/** One open terminal session eligible to be a broadcast target. */
export interface BroadcastSession {
  /** pty / ssh session id */
  id: string
  title: string
  isSsh: boolean
  /**
   * dockview panel showing this session. One session can back several panels —
   * an SSH split deliberately mirrors a single session — so registrations are
   * keyed by panel: closing one pane must not unregister the pane that is still
   * showing that session.
   */
  panelId: string
}

export interface BroadcastState {
  /** master switch; only settable while there are >= 2 open sessions */
  enabled: boolean
  /** session ids receiving broadcast input */
  targets: Set<string>
  /** open terminal sessions, registration order preserved */
  sessions: BroadcastSession[]
  /** register a panel's session as broadcast-eligible (upsert, keeps it fresh) */
  registerSession: (session: BroadcastSession) => void
  /**
   * drop one panel's registration; the session leaves `sessions` (and the
   * targets, possibly auto-disabling) only once no panel shows it any more
   */
  unregisterSession: (panelId: string) => void
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

/**
 * panelId → registration. The session list is derived from these rather than
 * maintained alongside them: one session can back several panels (an SSH split
 * mirrors a single session on purpose), and only the last panel to unmount may
 * take the session out of the registry.
 */
const registrations = new Map<string, BroadcastSession>()

/** One entry per session, in first-registration order, latest title wins. */
function deriveSessions(): BroadcastSession[] {
  const bySession = new Map<string, BroadcastSession>()
  for (const registration of registrations.values()) bySession.set(registration.id, registration)
  return [...bySession.values()]
}

export const useBroadcastStore = create<BroadcastState>((set) => ({
  enabled: false,
  targets: new Set(),
  sessions: [],

  registerSession: (session) => {
    registrations.set(session.panelId, session)
    set({ sessions: deriveSessions() })
  },

  unregisterSession: (panelId) =>
    set((state) => {
      const dropped = registrations.get(panelId)
      if (!dropped) return {}
      registrations.delete(panelId)
      const sessions = deriveSessions()
      // another pane still shows this session — keep it, and its target slot
      if (sessions.some((s) => s.id === dropped.id)) return { sessions }
      if (!state.targets.has(dropped.id)) return { sessions }
      const targets = new Set(state.targets)
      targets.delete(dropped.id)
      return { sessions, ...pruneOnTargetLoss(state.enabled, targets) }
    }),

  toggleTarget: (id) =>
    set((state) => {
      const targets = new Set(state.targets)
      if (targets.has(id)) {
        targets.delete(id)
        // Deliberate uncheck: keep the remaining selection — broadcast just
        // turns off below the 2-target minimum. Only session loss (see
        // unregisterSession) may wipe the set.
        if (targets.size < 2) return { enabled: false, targets }
        return { enabled: state.enabled, targets }
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