import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { App, Button, Checkbox, Popover, Tooltip } from 'antd'
import type { MenuProps } from 'antd'
import {
  CloudServerOutlined,
  CodeOutlined,
  LayoutOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  PlusOutlined,
  SettingOutlined,
  ShareAltOutlined
} from '@ant-design/icons'
import { DockviewReact } from 'dockview-react'
import type {
  DockviewApi,
  DockviewPanelApi,
  DockviewReadyEvent,
  DockviewTheme,
  IDockviewHeaderActionsProps,
  IDockviewPanel,
  IDockviewPanelHeaderProps,
  IDockviewPanelProps,
  SerializedDockview
} from 'dockview-react'
import 'dockview-react/dist/styles/dockview.css'

import { connectPromptFor, type HostKeyPromptEvent, type SshConnection, type SshSecretOverride } from '@shared/connections'
import { t } from '@shared/i18n'
import { nextTerminalTitle, retitleAutoTitles } from '@shared/terminalTitle'
import { ConnectionSidebar } from '../connections/ConnectionSidebar'
import type { ConnectionSidebarHandle } from '../connections/ConnectionSidebar'
import { ConnectFlow } from './ConnectFlow'
import { HostKeyModal } from './HostKeyModal'
import { TerminalPanel } from './TerminalPanel'
import { ApplyTemplateModal, SaveTemplateModal, TerminalTab } from './TerminalTab'
import { useBroadcastStore, writeBroadcast } from './broadcastStore'
import { forgetSessionCwd, getSessionCwd, onSessionCwdChange, setSessionCwd } from './sessionCwdStore'
import { useSettingsStore } from '@renderer/settings/store'
import type { SessionSnapshot, SessionPanelState } from '@shared/ipc'
import type { WorkspaceMode } from './workspaceMode'
import { useWorkspaceModeStore } from './workspaceModeStore'
import './workspace.css'

export interface WorkspaceProps {
  onOpenSettings: () => void
}

interface LayoutMetaLike {
  id: string
  name: string
  createdAt: number
}

interface TerminalParams {
  sessionId?: string
  sessionKind?: 'local' | 'ssh'
  hostLabel?: string
  /** saved SSH connection this session came from, for per-host highlight profiles */
  connectionId?: string
}

export type { TerminalParams }

const TERMINAL_COMPONENT = 'terminal'
const TERMINAL_TAB_COMPONENT = 'terminal-tab'

/**
 * Sessions we already asked to kill — kill once, never twice.
 *
 * Module-level rather than a ref so the dockview `components` /
 * `tabComponents` maps below can be module constants: dockview re-runs its prop
 * effects on every identity change and each `updateOptions` ends in an
 * unconditional `_layoutFromShell()`.
 */
const deadSessions = new Set<string>()

/** Mark a session dead ahead of a panel close so the cleanup skips it. */
function markSessionDead(sessionId: string): void {
  deadSessions.add(sessionId)
}

const DOCKVIEW_THEME: DockviewTheme = {
  name: 'Abyss',
  className: 'dockview-theme-abyss',
  colorScheme: 'dark'
}

const DOCKVIEW_COMPONENTS = {
  [TERMINAL_COMPONENT]: (props: IDockviewPanelProps<TerminalParams>) => (
    <TerminalPanel {...props} onSessionDead={markSessionDead} />
  )
}

const DOCKVIEW_TAB_COMPONENTS = {
  [TERMINAL_TAB_COMPONENT]: (props: IDockviewPanelHeaderProps<TerminalParams>) => (
    <TerminalTab {...props} />
  )
}

/** A queued host-key prompt plus the time it was queued — see the TTL sweep. */
interface QueuedHostKeyPrompt extends HostKeyPromptEvent {
  enqueuedAt: number
}

/**
 * How long a queued host-key prompt is worth answering. Mirrors the main
 * process' `DEFAULT_TIMEOUTS.prompt` (src/main/ssh.ts): once that elapses the
 * prompt has already been resolved as a reject and dropped there, so a
 * decision of ours can no longer reach it.
 */
const HOST_KEY_PROMPT_TTL_MS = 120_000

/** Expired-prompt sweep interval (rendering draws the queue head only). */
const HOST_KEY_SWEEP_MS = 5_000

/**
 * Electron re-throws a main-process rejection as
 * `Error: Error invoking remote method 'x': Error: <real message>`, so the real
 * cause has to be unwrapped to be worth showing.
 */
function connectFailureMessage(error: unknown): string {
  const generic = t('workspace.connect.failed')
  if (!(error instanceof Error)) return generic
  const detail = error.message
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^Error:\s*/, '')
    .trim()
  return detail ? `${generic}: ${detail}` : generic
}

/**
 * Put a `toJSON()` snapshot back into a dockview, swallowing a failure.
 *
 * Only used on the error path of a template load, where the dockview has just
 * been wiped: a second throw must not escape into the caller, or it would skip
 * the session cleanup that follows.
 */
function restoreLayoutSnapshot(api: DockviewApi | undefined, snapshot: SerializedDockview): void {
  if (!api) return
  try {
    api.fromJSON(snapshot)
  } catch (error) {
    console.error('[workspace] restoring the layout after a failed template apply failed', error)
  }
}

function sessionIdOf(panel: IDockviewPanel | undefined): string | undefined {
  return (panel?.params as TerminalParams | undefined)?.sessionId
}

/**
 * A dockview panel id.
 *
 * Panel ids must never be reused as pty session ids. `updateParameters` can
 * swap the session behind a panel, but the panel id is fixed for the panel's
 * whole life, so an id that doubles as a session id goes stale the moment the
 * pane is rebound: the restored pane would be addressed by an id that no longer
 * names any session, and it comes up with no pty behind it. Ids here are opaque
 * and distinct from any session id by construction.
 */
function panelId(): string {
  return `p-${window.crypto.randomUUID().slice(0, 8)}`
}

interface RawLayout {
  grid?: unknown
  panels?: Record<string, { id?: string; params?: { sessionId?: string } }>
  activeGroup?: string
}

interface RenamedLayout {
  layout: unknown
  /** old panel id → new panel id, so a caller holding a snapshot keyed by the
   *  old ids can still find a panel's recorded state afterwards. */
  renames: Map<string, string>
}

/**
 * Rewrite a snapshot layout so no panel id equals its session id.
 *
 * Older builds created panels with `id: sessionId`, and those snapshots are
 * still on disk. `updateParameters` cannot rename a panel, so the id has to be
 * swapped in the serialized layout where it appears in all three places that
 * must agree: the `panels` map key, the panel's own `id`, and every `views`
 * entry in the grid tree.
 *
 * Returns the layout untouched when no collision exists (the common case), so
 * the fast path stays a plain object reference.
 */
function breakIdCoincidence(layout: unknown): RenamedLayout {
  if (!layout || typeof layout !== 'object') return { layout, renames: new Map() }
  const raw = layout as RawLayout
  const panels = raw.panels
  if (!panels) return { layout, renames: new Map() }
  const renames = new Map<string, string>()
  for (const [key, panel] of Object.entries(panels)) {
    const sessionId = panel?.params?.sessionId
    if (sessionId && key === sessionId) renames.set(key, panelId())
  }
  if (renames.size === 0) return { layout, renames }

  const next: RawLayout = { ...raw, panels: {} }
  for (const [key, panel] of Object.entries(panels)) {
    const target = renames.get(key)
    next.panels![target ?? key] = target ? { ...panel, id: target } : panel
  }
  // `views` / `activeView` are the only fields naming panels. Three shapes to
  // tell apart, and the walk must preserve whichever is present:
  //   grid   { root, width, height, orientation }
  //   branch { type: 'branch', data: node[], size }
  //   leaf   { type: 'leaf', data: { views, activeView, id }, size }
  const renameLeaf = (leaf: Record<string, unknown>): Record<string, unknown> => {
    if (!Array.isArray(leaf.views)) return leaf
    return {
      ...leaf,
      views: leaf.views.map((v) => (typeof v === 'string' ? renames.get(v) ?? v : v)),
      activeView:
        typeof leaf.activeView === 'string' ? renames.get(leaf.activeView) ?? leaf.activeView : leaf.activeView
    }
  }
  const renameNode = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(renameNode)
    if (!node || typeof node !== 'object') return node
    const entry = node as Record<string, unknown>
    if (entry.type === 'leaf' || entry.type === 'branch') {
      const data = entry.data
      if (entry.type === 'leaf' && data && typeof data === 'object' && !Array.isArray(data)) {
        return { ...entry, data: renameLeaf(data as Record<string, unknown>) }
      }
      return { ...entry, data: renameNode(data) }
    }
    // The grid wrapper (and anything else shaped like it) keys its tree on `root`.
    if (entry.root !== undefined) return { ...entry, root: renameNode(entry.root) }
    return node
  }
  next.grid = renameNode(raw.grid)
  return { layout: next, renames }
}

/** The dockview api that owns a given workspace mode. */
function apiOfMode(mode: WorkspaceMode, terminalApi: DockviewApi | undefined, sshApi: DockviewApi | undefined): DockviewApi | undefined {
  return mode === 'terminal' ? terminalApi : sshApi
}

/** Shared per-mode right-header actions (the "＋" creates a terminal in the
 *  terminal dockview and hints from the server list in the ssh dockview). */
function createTabActions(mode: WorkspaceMode): (props: IDockviewHeaderActionsProps) => React.JSX.Element {
  function TabActions({ containerApi, group }: IDockviewHeaderActionsProps): React.JSX.Element {
    // The per-group "＋" creates a local terminal — SSH sessions can only be
    // opened from the server list, so in ssh mode the button just hints.
    const { message } = App.useApp()
    const handleAdd = (): void => {
      if (mode === 'ssh') {
        message.info(t('workspace.hint.sshFromList'))
        return
      }
      void (async (): Promise<void> => {
        const result = await window.api.createPty()
        setSessionCwd(result.id, result.cwd)
        containerApi.addPanel<TerminalParams>({
          id: panelId(),
          component: TERMINAL_COMPONENT,
          tabComponent: TERMINAL_TAB_COMPONENT,
          title: nextTerminalTitle(containerApi.panels.map((p) => p.title)),
          params: { sessionId: result.id, sessionKind: 'local' },
          position: { referenceGroup: group.id, direction: 'within' }
        })
      })()
    }

    return (
      <div className="workspace-tabbar-actions">
        <AddTerminalGroupButton onClick={handleAdd} />
        <BroadcastToggleButton />
      </div>
    )
  }
  return TabActions
}

const TerminalTabActions = createTabActions('terminal')
const SshTabActions = createTabActions('ssh')

/**
 * Workspace owns TWO independent dockviews — one for local terminals, one for
 * SSH sessions — so the two session kinds never mix on the same tab strip.
 * Switching workspace mode simply toggles `display:none` on the container div
 * (React state / panel instances stay mounted, so the switch is free).
 *
 * Sessions: panels carry a `params.sessionId`. Killing a session is idempotent
 * through the `deadSessions` set so a session is killed at most once — either
 * up-front (TerminalView `onClose` after the process exits) or when its panel
 * is removed. Each dockview registers `onDidRemovePanel` so a panel close in
 * either workspace kills the bound session.
 */
export default function Workspace({ onOpenSettings }: WorkspaceProps): React.JSX.Element {
  const { message } = App.useApp()
  /** Dockview apis for the two isolated workspaces. */
  const terminalApiRef = useRef<DockviewApi | undefined>(undefined)
  const sshApiRef = useRef<DockviewApi | undefined>(undefined)
  /** Currently selected workspace group (terminal / ssh) — drives visibility. */
  const workspaceMode = useWorkspaceModeStore((s) => s.mode)
  /** session counts per dockview — "empty" means no *session* panel. */
  const [modeCounts, setModeCounts] = useState<{ terminal: number; ssh: number }>({
    terminal: 0,
    ssh: 0
  })
  const terminalCount = modeCounts.terminal
  const sshCount = modeCounts.ssh
  /** Per-workspace active panel used as the split anchor. */
  const activeTerminalPanelRef = useRef<IDockviewPanel | undefined>(undefined)
  const activeSshPanelRef = useRef<IDockviewPanel | undefined>(undefined)
  /** The currently-visible mode's active panel (broadcast target). */
  const activePanelRef = useRef<IDockviewPanel | undefined>(undefined)

  /** Bind-time disposables for both dockviews, disposed on unmount. */
  const disposablesRef = useRef<Array<{ dispose(): void }>>([])

  const [saveOpen, setSaveOpen] = useState(false)
  const [applyOpen, setApplyOpen] = useState(false)
  /** Terminal dockview ready — gates first-run seeding. */
  const [terminalReady, setTerminalReady] = useState(false)
  /** Settings hydrate is async — the boot pass must not read its defaults. */
  const settingsHydrated = useSettingsStore((s) => s.hydrated)

  /** Local terminal panels surfaced to the sidebar's "终端" section. */
  const [localPanels, setLocalPanels] = useState<Array<{ id: string; title: string }>>([])
  /** id of the currently active panel (for sidebar highlight). */
  const [activePanelId, setActivePanelId] = useState<string | null>(null)

  /** [侧栏] toggle — hidden by default; the choice persists per device. */
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() =>
    window.localStorage.getItem('ot.sidebarOpen') === '1'
  )
  const toggleSidebar = useCallback((): void => {
    setSidebarOpen((prev) => {
      const next = !prev
      window.localStorage.setItem('ot.sidebarOpen', next ? '1' : '0')
      return next
    })
  }, [])
  /** one pending SSH connection request (null = idle). */
  const [requestedConn, setRequestedConn] = useState<SshConnection | null>(null)
  /** In-flight openSession attempts (0 = idle); the rail busy dot reads it. */
  const [connectingCount, setConnectingCount] = useState(0)
  const connecting = connectingCount > 0
  /** Re-entrancy guard for `connect` — a second attempt while one is in flight
   *  is dropped (openSession cannot be aborted and would orphan a session). */
  const connectInFlightRef = useRef(0)
  /** Re-entrancy guard for `handleApplyTemplate` — an overlapping second apply
   *  would collect the sessions the first one just restored as its own
   *  "previous" set and kill them. */
  const applyTemplateInFlightRef = useRef(false)
  /** FIFO of pending host-key confirmations — render the head only. */
  const [hostKeyQueue, setHostKeyQueue] = useState<QueuedHostKeyPrompt[]>([])

  /** B's sidebar handle; refresh() after a successful SSH connect */
  const sidebarRef = useRef<ConnectionSidebarHandle>(null)

  // ---- session memory (restore last layout + per-pane cwd) ----
  /** Set once the boot pass has read the snapshot; saves stay quiet until then. */
  const bootDoneRef = useRef(false)
  /** Debounce handle for the snapshot write. */
  const saveTimerRef = useRef(0)
  /** Newest local directory seen — seeds brand-new terminals. */
  const lastLocalCwdRef = useRef<string | null>(null)

  /** Assemble what the next launch needs: both layouts, every pane's kind and
   *  directory, and the workspace the user was in. */
  const buildSnapshot = useCallback((): SessionSnapshot => {
    const collect = (api: DockviewApi | undefined): SessionPanelState[] => {
      if (!api) return []
      return api.panels.map((panel) => {
        const params = panel.params as TerminalParams | undefined
        return {
          panelId: panel.id,
          title: panel.title ?? '',
          kind: params?.sessionKind === 'ssh' ? 'ssh' : 'local',
          cwd: getSessionCwd(params?.sessionId),
          hostLabel: params?.hostLabel
        }
      })
    }
    return {
      version: 1,
      savedAt: Date.now(),
      mode: useWorkspaceModeStore.getState().mode,
      layouts: {
        terminal: terminalApiRef.current?.toJSON(),
        ssh: sshApiRef.current?.toJSON()
      },
      panels: [...collect(terminalApiRef.current), ...collect(sshApiRef.current)],
      lastLocalCwd: lastLocalCwdRef.current ?? undefined
    }
  }, [])

  /** Debounced write (layout changes stream during window drags). */
  const scheduleSave = useCallback((): void => {
    // Never overwrite the snapshot before the boot pass has read it — an empty
    // layout would otherwise erase the very thing we are about to restore.
    if (!bootDoneRef.current) return
    window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = window.setTimeout(() => {
      void window.api.saveSessionState(buildSnapshot()).catch(() => undefined)
    }, 500)
  }, [buildSnapshot])

  /** Idempotently kill a pty session. */
  const killSession = useCallback((sessionId: string | undefined): void => {
    if (!sessionId) return
    if (deadSessions.has(sessionId)) return
    deadSessions.add(sessionId)
    window.api.killPty(sessionId)
  }, [])

  const createSession = useCallback(async (cwd?: string): Promise<string> => {
    // `cwd` is the memory hook: a restored pane and a freshly opened one both
    // start where the user left off. The main process validates the path and
    // answers with the directory it actually used, which seeds the cwd store so
    // an immediate snapshot save already reflects it.
    const result = await window.api.createPty(cwd ? { cwd } : {})
    setSessionCwd(result.id, result.cwd)
    return result.id
  }, [])

  /** Rebuild the local-terminal list for the sidebar's "终端" section. The
   *  terminal dockview holds only local sessions, so it is the single source. */
  const recomputeLocalPanels = useCallback((): void => {
    const current = terminalApiRef.current
    const panels = current
      ? current.panels
          .filter((p) => (p.params as TerminalParams | undefined)?.sessionKind === 'local')
          .map((p) => ({ id: p.id, title: p.title ?? '' }))
      : []
    // Keep the previous array when nothing changed: a fresh array on every
    // layout event re-renders the sidebar (and the whole workspace) for nothing.
    setLocalPanels((prev) =>
      prev.length === panels.length &&
      prev.every((panel, i) => panel.id === panels[i].id && panel.title === panels[i].title)
        ? prev
        : panels
    )
  }, [])

  /** Recount session panels per dockview into local state. */
  const recountAll = useCallback((): void => {
    const terminal = terminalApiRef.current
    const ssh = sshApiRef.current
    const t = terminal ? terminal.panels.filter((p) => sessionIdOf(p)).length : 0
    const s = ssh ? ssh.panels.filter((p) => sessionIdOf(p)).length : 0
    setModeCounts((prev) => (prev.terminal === t && prev.ssh === s ? prev : { terminal: t, ssh: s }))
  }, [])

  /**
   * Re-render every auto-numbered tab title in the active language, keeping its
   * number. Idempotent — a title already in the active language is left alone.
   *
   * Titles are stored display text (they ride along in layout templates, the
   * session snapshot and the broadcast registry) and outlive a language switch,
   * so without this a pane keeps the wording of the language it was opened in.
   *
   * SSH panes are excluded: their title is the connection name the user typed,
   * and a connection named "Terminal 3" must not be renamed behind their back.
   *
   * `setTitle` fires dockview's title-change event, which is all the rest needs:
   * `TerminalPanel` re-registers the broadcast title, the tab component
   * re-renders, the sidebar list refreshes and the snapshot save is scheduled
   * (a panel title change forwards into the dockview's layout-change event).
   */
  const retitleAutoPanels = useCallback((): void => {
    retitleAutoTitles(
      [terminalApiRef.current, sshApiRef.current].flatMap((api) =>
        (api?.panels ?? []).filter(
          (panel) => (panel.params as TerminalParams | undefined)?.sessionKind !== 'ssh'
        )
      )
    )
  }, [])

  /** Focus a local terminal panel from the sidebar (terminal dockview). */
  const onFocusPanel = useCallback((panelId: string): void => {
    const panel = terminalApiRef.current?.getPanel(panelId)
    if (!panel) return
    useWorkspaceModeStore.getState().setMode('terminal')
    panel.api.setActive()
  }, [])

  /**
   * Bind a dockview's api: stash it in its ref, subscribe to lifecycle events
   * (remove → kill session, active → track panel), and keep indices fresh.
   */
  const bindApi = useCallback(
    (mode: WorkspaceMode, api: DockviewApi): void => {
      if (mode === 'terminal') terminalApiRef.current = api
      else sshApiRef.current = api

      // One pty/ssh session can back several panels — an SSH split mirrors a
      // single session on purpose. So closing a panel must not kill a session
      // another panel is still showing: ask the panels that exist right now
      // rather than keep a running count, so the answer cannot drift away from
      // the layout (a panel's session is swapped in place by `updateParameters`,
      // and a layout load replaces every panel of a dockview at once).
      const releaseSession = (panel: IDockviewPanel): void => {
        const sid = sessionIdOf(panel)
        if (!sid) return
        for (const other of api.panels) if (sessionIdOf(other) === sid) return
        killSession(sid)
        // No pane shows this session any more: drop its bookkeeping too, so
        // neither the dead-session set nor the cwd map grows for the whole run.
        deadSessions.delete(sid)
        forgetSessionCwd(sid)
      }

      const cleanups = [
        api.onDidRemovePanel((panel: IDockviewPanel) => {
          // Closing a pane keeps its directory as the seed for the next one.
          // SSH panes are excluded: their tracked cwd is a *remote* path (OSC 7
          // from the remote shell), and seeding a new local terminal with it
          // would silently break "start where I left off".
          if ((panel.params as TerminalParams | undefined)?.sessionKind !== 'ssh') {
            const closing = getSessionCwd(sessionIdOf(panel))
            if (closing) lastLocalCwdRef.current = closing
          }
          releaseSession(panel)
          recomputeLocalPanels()
          recountAll()
          scheduleSave()
        }),
        api.onDidActivePanelChange((event) => {
          if (mode === 'terminal') activeTerminalPanelRef.current = event.panel ?? undefined
          else activeSshPanelRef.current = event.panel ?? undefined
          if (useWorkspaceModeStore.getState().mode === mode) {
            activePanelRef.current = event.panel ?? undefined
            setActivePanelId(event.panel?.id ?? null)
          }
        }),
        api.onDidLayoutChange(() => {
          recomputeLocalPanels()
          recountAll()
          scheduleSave()
        }),
        api.onDidAddPanel(() => {
          recountAll()
          scheduleSave()
        })
      ]
      disposablesRef.current.push(...cleanups)
    },
    [killSession, recomputeLocalPanels, recountAll, scheduleSave]
  )

  const handleTerminalReady = useCallback(
    (event: DockviewReadyEvent): void => {
      bindApi('terminal', event.api)
      recountAll()
      recomputeLocalPanels()
      setTerminalReady(true)
    },
    [bindApi, recountAll, recomputeLocalPanels]
  )

  const handleSshReady = useCallback(
    (event: DockviewReadyEvent): void => {
      bindApi('ssh', event.api)
      recountAll()
    },
    [bindApi, recountAll]
  )

  /** Dispose dockview subscriptions on unmount. */
  useEffect(() => {
    return () => {
      for (const disposable of disposablesRef.current) disposable.dispose()
      disposablesRef.current = []
    }
  }, [])

  /** Keep `activePanelRef` pointing at the currently-visible workspace's
   *  active panel whenever the mode changes (a mode toggle alone doesn't fire
   *  onDidActivePanelChange). */
  useEffect(() => {
    const sync = (): void => {
      const mode = useWorkspaceModeStore.getState().mode
      const api = apiOfMode(mode, terminalApiRef.current, sshApiRef.current)
      const active = api?.activePanel
      activePanelRef.current = active ?? undefined
      setActivePanelId(active?.id ?? null)
    }
    sync()
    return useWorkspaceModeStore.subscribe(sync)
  }, [])

  /** Session memory follows the directories the panes report and the workspace
   *  the user is in — both feed the debounced snapshot write. */
  useEffect(() => {
    const offCwd = onSessionCwdChange(() => {
      const active = getSessionCwd(sessionIdOf(activeTerminalPanelRef.current))
      if (active) lastLocalCwdRef.current = active
      scheduleSave()
    })
    const offMode = useWorkspaceModeStore.subscribe(() => scheduleSave())
    return () => {
      offCwd()
      offMode()
    }
  }, [scheduleSave])

  /**
   * Boot pass: pick up where the user left off — layout plus each pane's
   * directory — when 设置 → 系统 → 启动时恢复上次会话 is on. Otherwise (or when no
   * snapshot exists) seed one terminal. Either way the workspace is never empty.
   *
   * Gated on the settings hydrate: reading `restoreSession` before it lands
   * always sees the defaults, so a user who turned restore off got their session
   * back whenever the dockview became ready first.
   */
  useEffect(() => {
    if (!terminalReady || !settingsHydrated) return
    let cancelled = false
    void (async (): Promise<void> => {
      const current = terminalApiRef.current
      if (!current) return
      try {
        const restoreOn = useSettingsStore.getState().settings.system.restoreSession !== false
        const snapshot = restoreOn ? await window.api.getSessionState().catch(() => null) : null
        if (cancelled) return
        const restorable = Boolean(snapshot && (snapshot.layouts.terminal || snapshot.panels.length > 0))
        const restored = snapshot && restorable ? await restoreFromSnapshot(snapshot) : false
        if (cancelled) return
        if (!restored && !current.panels.some((p) => sessionIdOf(p))) await addTerminal()
      } catch (error) {
        // An escaped rejection used to leave the workspace half-applied: the
        // boot flag never flipped (so no snapshot was ever saved again) and the
        // panes the pass had not reached stayed bound to dead session ids.
        console.error('[workspace] session restore failed', error)
        if (!cancelled) message.error(t('workspace.error.title'))
      } finally {
        bootDoneRef.current = true
        scheduleSave()
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- boot once, on ready + hydrated
  }, [terminalReady, settingsHydrated])

  /** Kill remaining sessions on window close. */
  useEffect(() => {
    const handler = (): void => {
      for (const api of [terminalApiRef.current, sshApiRef.current]) {
        if (!api) continue
        for (const panel of api.panels) {
          killSession(sessionIdOf(panel))
        }
      }
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [killSession])

  /**
   * Host-key verification subscription. Events stream in a FIFO queue; each
   * workspace shows a single modal over its head and pops on every decision.
   */
  useEffect(() => {
    return window.api.onHostKeyPrompt((event: HostKeyPromptEvent) => {
      setHostKeyQueue((prev) => [...prev, { ...event, enqueuedAt: Date.now() }])
    })
  }, [])

  // A prompt the main process gave up on never gets a decision from the user:
  // its own timeout resolves the attempt as a reject and stops tracking the
  // prompt, but nothing tells the renderer. Since only the head is rendered,
  // such an entry would hold the single visible slot forever and block every
  // later host's prompt behind it, so sweep the expired ones out.
  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = Date.now()
      setHostKeyQueue((prev) => {
        const next = prev.filter((p) => now - p.enqueuedAt < HOST_KEY_PROMPT_TTL_MS)
        return next.length === prev.length ? prev : next
      })
    }, HOST_KEY_SWEEP_MS)
    return () => window.clearInterval(timer)
  }, [])

  const hostKeyHead = hostKeyQueue.length > 0 ? hostKeyQueue[0] : null

  const handleHostKeyDecision = useCallback(
    (promptId: string, action: 'accept' | 'reject'): void => {
      // The head's decision is final (accept/reject both consume the prompt).
      // The IPC call belongs here, not inside the updater: React may re-run an
      // updater (it does so deliberately to surface impure ones), which would
      // answer the prompt — and log it as unanswered — more than once.
      window.api.respondHostKey(promptId, action)
      setHostKeyQueue((prev) => prev.filter((p) => p.promptId !== promptId))
    },
    []
  )

  /**
   * M6: Ctrl+PgUp / Ctrl+PgDn cycle tabs. Registered on `window` with
   * capture:true so it runs before xterm's own key handling; it only cycles the
   * currently-visible workspace's session panels.
   */
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      // Tab cycling must not move an invisible workspace while the lock
      // overlay covers the main window.
      if (document.documentElement.dataset.locked === 'true') return
      const ctrl = e.ctrlKey
      const code = e.code
      if (!ctrl || (code !== 'PageUp' && code !== 'PageDown')) return
      const mode = useWorkspaceModeStore.getState().mode
      const current = apiOfMode(mode, terminalApiRef.current, sshApiRef.current)
      if (!current) return
      const panels = current.panels.filter((p) => sessionIdOf(p))
      if (panels.length < 2) return
      e.preventDefault()
      e.stopPropagation()
      const active = current.activePanel ?? activePanelRef.current
      let idx = active ? panels.findIndex((p) => p.id === active.id) : -1
      const step = code === 'PageDown' ? 1 : -1
      let next = active
      for (let i = 1; i <= panels.length; i++) {
        const candidate = panels[(idx + step * i + panels.length * 2) % panels.length]
        if (sessionIdOf(candidate)) {
          next = candidate
          break
        }
      }
      if (next && next !== active) next.api.setActive()
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [])

  /** New local terminals always land in the terminal dockview. Ensure it is
   *  visible first so the new panel shows up. */
  const addTerminal = useCallback(
    async (direction?: 'right' | 'below'): Promise<void> => {
      const current = terminalApiRef.current
      if (!current) return
      useWorkspaceModeStore.getState().setMode('terminal')
      // Start where the user already is: the active pane's directory, else the
      // most recent one we saw (e.g. the pane they just closed).
      const inherit =
        getSessionCwd(sessionIdOf(activeTerminalPanelRef.current)) ?? lastLocalCwdRef.current ?? undefined
      const sessionId = await createSession(inherit)
      const reference = activeTerminalPanelRef.current

      current.addPanel<TerminalParams>({
        id: panelId(),
        component: TERMINAL_COMPONENT,
        tabComponent: TERMINAL_TAB_COMPONENT,
        title: nextTerminalTitle(current.panels.map((p) => p.title)),
        params: { sessionId, sessionKind: 'local' },
        position:
          reference && direction
            ? { referencePanel: reference.id, direction }
            : undefined
      })
    },
    [createSession]
  )

  /**
   * SSH connection pipeline. openSession resolves once the session is ready to
   * stream; `connectionId` + any staged `secretOverride` are the only inputs
   * the main process needs — no extra IPC channel. New sessions land in the ssh
   * dockview.
   *
   * Re-entrant calls are dropped: a double-click would otherwise open two
   * sessions for one click, and openSession cannot be aborted once it is away.
   */
  const connect = useCallback(
    async (conn: SshConnection, secretOverride: SshSecretOverride): Promise<void> => {
      if (connectInFlightRef.current > 0) return
      connectInFlightRef.current += 1
      setConnectingCount((count) => count + 1)
      try {
        const result = await window.api.openSession({
          kind: 'ssh',
          connectionId: conn.id,
          secretOverride
        })
        const current = sshApiRef.current
        if (!current) return
        // SSH sessions belong to the ssh workspace — switch to it so the panel
        // is visible once added.
        useWorkspaceModeStore.getState().setMode('ssh')
        current.addPanel<TerminalParams>({
          id: panelId(),
          component: TERMINAL_COMPONENT,
          tabComponent: TERMINAL_TAB_COMPONENT,
          title: conn.name,
          params: { sessionId: result.id, sessionKind: 'ssh', hostLabel: conn.host, connectionId: conn.id }
        })
        // B's sidebar refreshes lastConnectedAt on connect.
        void sidebarRef.current?.refresh()
      } catch (error) {
        message.error(connectFailureMessage(error))
      } finally {
        connectInFlightRef.current -= 1
        setConnectingCount((count) => count - 1)
        setRequestedConn(null)
      }
    },
    [message]
  )

  const handleConnectRequest = useCallback(
    (conn: SshConnection): void => {
      if (connectInFlightRef.current > 0) return
      // Ask-at-connect connections go through the secret prompt first (the
      // prompt kind comes from the shared `connectPromptFor`, so a stale ask
      // flag from a switched auth method can never pop the wrong dialog);
      // saved credentials must connect IMMEDIATELY — routing them through
      // ConnectFlow would only ever *render* a "connecting" spinner without
      // firing openSession.
      const prompt = connectPromptFor(conn)
      if (prompt !== null) {
        setRequestedConn(conn)
        return
      }
      // Immediate path: show the same uncancellable "连接中" modal the secret
      // path uses, so the server list is not clickable while openSession flies.
      setRequestedConn(conn)
      void connect(conn, {})
    },
    [connect]
  )

  const handleConnectCancel = useCallback((): void => {
    setRequestedConn(null)
  }, [])

  const handleSecretConfirmed = useCallback(
    (secretOverride: SshSecretOverride): void => {
      const conn = requestedConn
      if (!conn) return
      // Swap the secret modal for the connecting modal and fire openSession.
      setRequestedConn(conn)
      void connect(conn, secretOverride)
    },
    [requestedConn, connect]
  )

  const handleNewTerminal = useCallback((): void => {
    void addTerminal()
  }, [addTerminal])

  /** Icon-rail "＋": in terminal mode make a terminal; in ssh mode hand off to
   *  the server list instead (SSH sessions can't be created on the fly). */
  const handleRailNewTerminal = useCallback((): void => {
    const mode = useWorkspaceModeStore.getState().mode
    if (mode === 'ssh') {
      message.info(t('workspace.hint.sshFromList'))
      return
    }
    void addTerminal()
  }, [addTerminal, message])

  const handleSplit = useCallback(
    (direction: 'right' | 'below'): void => {
      const mode = useWorkspaceModeStore.getState().mode
      if (mode === 'terminal') {
        // New local terminal split in the terminal workspace.
        void addTerminal(direction)
        return
      }
      // ssh mode: split only when there's already a live SSH session to split.
      const current = sshApiRef.current
      const hasSession = current ? current.panels.some((p) => sessionIdOf(p)) : false
      if (!hasSession) {
        message.info(t('workspace.hint.connectSshFirst'))
        return
      }
      const reference = activeSshPanelRef.current
      if (!reference || !current) return
      const sessionId = sessionIdOf(reference)
      if (!sessionId) return
      const refParams = reference.params as TerminalParams | undefined
      current.addPanel<TerminalParams>({
        id: panelId(),
        component: TERMINAL_COMPONENT,
        tabComponent: TERMINAL_TAB_COMPONENT,
        title: reference.title,
        params: { sessionId, sessionKind: 'ssh', hostLabel: refParams?.hostLabel, connectionId: refParams?.connectionId },
        position: { referencePanel: reference.id, direction }
      })
    },
    [message, addTerminal]
  )

  const handleSaveTemplate = useCallback(async (name: string): Promise<void> => {
    await window.api.saveLayout(
      {
        id: window.crypto.randomUUID(),
        name,
        createdAt: Date.now()
      },
      JSON.stringify({
        terminal: terminalApiRef.current?.toJSON(),
        ssh: sshApiRef.current?.toJSON()
      })
    )
  }, [])

  /**
   * Replace the pty behind an existing panel, in place.
   *
   * Panel identity and session identity are deliberately separate: a panel keeps
   * its parameters object across `updateParameters`, so React re-renders the
   * panel's `<TerminalView>` with the new `sessionId` prop exactly the way it
   * does when the user switches terminals — its bind effect tears the old xterm
   * down and replays the new session's output.
   *
   * The owning dockview api comes along so the panel's survival can be checked
   * after the await: a pane closed while its pty was still starting would
   * otherwise leave that fresh session behind, bound to no panel and never
   * killed.
   */
  const bindPanelSession = useCallback(
    async (
      api: DockviewApi | undefined,
      panel: DockviewPanelApi | undefined,
      currentSessionId: string,
      cwd?: string
    ): Promise<void> => {
      if (!api || !panel) return
      try {
        const nextSessionId = await createSession(cwd)
        if (!api.getPanel(panel.id)) {
          killSession(nextSessionId)
          forgetSessionCwd(nextSessionId)
          return
        }
        panel.updateParameters({ sessionId: nextSessionId, sessionKind: 'local' })
        deadSessions.delete(currentSessionId)
        forgetSessionCwd(currentSessionId)
      } catch (error) {
        console.error('[workspace] panel rebind failed', error)
      }
    },
    [createSession, killSession]
  )

  /**
   * Rebind restored panels to fresh ptys.
   *
   * Templates cannot carry live session state (SSH needs credentials that are
   * never stored in a layout), so their panels are recreated as local terminals
   * in whichever workspace the layout put them.
   *
   * The automatic snapshot additionally carries each pane's last working
   * directory, and `dropSsh` closes ssh panes rather than faking them as local
   * terminals — a restored ssh pane has no session to show yet (the reconnect
   * placeholder is a follow-up).
   *
   * `renames` bridges the id rewrite the caller applied to the layout: the
   * snapshot is keyed by the panel ids *as they were written*, but the panels
   * now carry fresh ids, so a lookup by the new id would always miss and the
   * pane would silently lose its remembered directory.
   */
  const rebindSessionPanels = useCallback(
    async (
      api: DockviewApi | undefined,
      snapshot?: SessionSnapshot,
      dropSsh = false,
      renames?: Map<string, string>
    ): Promise<void> => {
      if (!api) return
      const recorded = new Map((snapshot?.panels ?? []).map((p) => [p.panelId, p]))
      const lookup = (panelId: string): SessionPanelState | undefined => {
        const direct = recorded.get(panelId)
        if (direct) return direct
        for (const [oldId, newId] of renames ?? []) {
          if (newId === panelId) return recorded.get(oldId)
        }
        return undefined
      }
      for (const panel of api.panels) {
        const id = sessionIdOf(panel)
        if (!id || panel.view.contentComponent !== TERMINAL_COMPONENT) continue
        if (dropSsh && (panel.params as TerminalParams | undefined)?.sessionKind === 'ssh') {
          panel.api.close()
          continue
        }
        // One pane failing to rebind must not abort the panes after it (they
        // would keep the stale session id of a previous launch and stay dead).
        try {
          await bindPanelSession(api, panel.api, id, lookup(panel.id)?.cwd)
        } catch (error) {
          console.error('[workspace] pane rebind failed', panel.id, error)
        }
      }
    },
    [bindPanelSession]
  )

  const rebindRestoredPanels = useCallback(
    async (api: DockviewApi): Promise<void> => {
      await rebindSessionPanels(api)
    },
    [rebindSessionPanels]
  )

  /**
   * Restore the previous layout and drop every pane back into the directory it
   * was left in. Returns false when the snapshot cannot be applied (an
   * incompatible dockview layout), so the caller falls back to a fresh terminal.
   *
   * The layout is rewritten before `fromJSON` sees it: a snapshot written by an
   * older build has `panelId === sessionId` for every pane (panel ids used to be
   * session ids), which is a state the restore can no longer represent — it
   * would reinstate a panel whose id names a session that does not exist, and
   * the pane stays dead. `breakIdCoincidence` gives those panels fresh ids up
   * front, so the reapplied layout always satisfies panel id ≠ session id.
   */
  const restoreFromSnapshot = useCallback(
    async (snapshot: SessionSnapshot): Promise<boolean> => {
      const terminal = terminalApiRef.current
      const ssh = sshApiRef.current
      const terminalLayout = breakIdCoincidence(snapshot.layouts.terminal)
      const sshLayout = breakIdCoincidence(snapshot.layouts.ssh)
      try {
        if (terminalLayout.layout) terminal?.fromJSON(terminalLayout.layout as never)
        if (sshLayout.layout) ssh?.fromJSON(sshLayout.layout as never)
      } catch {
        return false
      }
      const renames = new Map([...terminalLayout.renames, ...sshLayout.renames])
      await rebindSessionPanels(terminal, snapshot, true, renames)
      await rebindSessionPanels(ssh, snapshot, true, renames)
      // A snapshot is written in whatever language was active at the time, so
      // render its auto titles in the current language before anything compares
      // them: the dedup below then sees "终端 3" and "Terminal 3" as the one
      // collision they are instead of letting both through.
      retitleAutoPanels()
      // Retitle duplicates left over from the old counter bug (the snapshot it
      // wrote keeps colliding titles forever otherwise): the first panel keeps
      // the title, later ones get the lowest free number.
      //
      // Local terminals only: an SSH pane is titled with its server name, and a
      // split deliberately shares that title with its sibling, so the terminal
      // numbering pattern is the wrong remedy there.
      const seenTitles = new Set<string>()
      for (const p of [...(terminal?.panels ?? []), ...(ssh?.panels ?? [])]) {
        if ((p.params as TerminalParams | undefined)?.sessionKind === 'ssh') continue
        const title = p.title ?? ''
        if (!title) continue
        if (seenTitles.has(title)) {
          const fresh = nextTerminalTitle(seenTitles)
          p.setTitle(fresh)
          seenTitles.add(fresh)
        } else seenTitles.add(title)
      }
      lastLocalCwdRef.current = snapshot.lastLocalCwd ?? lastLocalCwdRef.current
      useWorkspaceModeStore.getState().setMode(snapshot.mode)
      recountAll()
      recomputeLocalPanels()
      return true
    },
    [rebindSessionPanels, recountAll, recomputeLocalPanels, retitleAutoPanels]
  )

  const handleApplyTemplate = useCallback(
    async (meta: LayoutMetaLike): Promise<void> => {
      // Overlapping applies corrupt each other: the second call would collect
      // the sessions the first one just restored into `previousSessions` and
      // kill them on the way out. Drop the second call instead.
      if (applyTemplateInFlightRef.current) return
      applyTemplateInFlightRef.current = true
      try {
        const raw = await window.api.getLayout(meta.id)
        if (raw == null) return

        // Sessions currently bound to panels — the template load replaces them.
        const previousSessions = new Set<string>()
        for (const api of [terminalApiRef.current, sshApiRef.current]) {
          if (!api) continue
          for (const panel of api.panels) {
            const sid = sessionIdOf(panel)
            if (sid) previousSessions.add(sid)
          }
        }

        let parsed: unknown
        try {
          parsed = JSON.parse(raw)
        } catch (error) {
          console.error('[workspace] template payload is not valid JSON', meta.id, error)
          message.error(t('workspace.template.applyFailed'))
          return
        }
        const payload = parsed as { terminal?: unknown; ssh?: unknown }
        const hasDualLayout = payload !== null && typeof payload === 'object' && 'terminal' in payload && 'ssh' in payload

        // Snapshot both dockviews before they are touched: a payload that
        // deserializes half-way (a template written by another build, a panel
        // whose component no longer exists) makes dockview clear every group and
        // panel it built *and* the layout it replaced, and only then rethrow
        // ("failed to deserialize layout. Reverting changes"). The snapshots are
        // the way back to the layout the user had.
        const terminalSnapshot = terminalApiRef.current?.toJSON()
        const sshSnapshot = sshApiRef.current?.toJSON()

        // Which dockview the payload reached — a failed load must not put a
        // snapshot back into one it never touched: restoring a dockview wipes the
        // panels that are still alive in it (and, through `onDidRemovePanel`,
        // kills the sessions behind them).
        let terminalTouched = false
        let sshTouched = false

        // Dual layout (M6.1+): restore each dockview from its own payload.
        // Legacy layout (pre-M6.1 single toJSON): restore it wholly into the
        // terminal dockview.
        try {
          if (hasDualLayout) {
            terminalTouched = true
            terminalApiRef.current?.fromJSON(payload.terminal as never)
            sshTouched = true
            sshApiRef.current?.fromJSON(payload.ssh as never)
          } else {
            // Legacy single-dockview layout → restore into the terminal workspace.
            terminalTouched = true
            terminalApiRef.current?.fromJSON((payload as unknown) as never)
          }
        } catch (error) {
          console.error('[workspace] template apply failed', meta.id, error)
          // The wipe took the panels down with it — and `onDidRemovePanel` took
          // their sessions, so the user is left with an empty workspace and
          // nothing to reattach to. Put each touched dockview back from its
          // snapshot, then give every pane that comes back a fresh session: the
          // one it used to show is gone.
          if (terminalTouched && terminalSnapshot) {
            restoreLayoutSnapshot(terminalApiRef.current, terminalSnapshot)
            if (terminalApiRef.current) await rebindRestoredPanels(terminalApiRef.current)
          }
          if (sshTouched && sshSnapshot) {
            restoreLayoutSnapshot(sshApiRef.current, sshSnapshot)
            if (sshApiRef.current) await rebindRestoredPanels(sshApiRef.current)
          }
          // No session may outlive its panels: the dockview the payload never
          // reached still shows its own (they stay), everything else goes.
          const live = new Set<string>()
          for (const api of [terminalApiRef.current, sshApiRef.current]) {
            for (const panel of api?.panels ?? []) {
              const sid = sessionIdOf(panel)
              if (sid) live.add(sid)
            }
          }
          for (const sid of previousSessions) if (!live.has(sid)) killSession(sid)
          // The panel counters and the sidebar list describe the aborted load,
          // not the layout that is back; rebuild both from the panels that are
          // actually here.
          recountAll()
          recomputeLocalPanels()
          const mode = useWorkspaceModeStore.getState().mode
          activePanelRef.current = apiOfMode(mode, terminalApiRef.current, sshApiRef.current)?.activePanel
          message.error(t('workspace.template.applyFailedRestored'))
          return
        }

        // Fresh sessions for every restored terminal panel. Only a dockview the
        // payload actually reached may be rebound: `rebindRestoredPanels`
        // rewrites each panel's params to a fresh *local* session, so running it
        // over a legacy template's untouched ssh workspace would demote its live
        // SSH panes to local terminals.
        if (terminalApiRef.current) await rebindRestoredPanels(terminalApiRef.current)
        if (sshTouched && sshApiRef.current) await rebindRestoredPanels(sshApiRef.current)

        // A template carries the tab titles it was saved with, which may be in
        // another language (or written by a build whose language the user has
        // since switched away from).
        retitleAutoPanels()

        // Old sessions are unreachable after the layout swap — kill them, but
        // only the ones no panel shows any more: a legacy template never reached
        // the ssh dockview, whose panes keep their live SSH sessions (the same
        // `live` test the failure path uses).
        const live = new Set<string>()
        for (const api of [terminalApiRef.current, sshApiRef.current]) {
          for (const panel of api?.panels ?? []) {
            const sid = sessionIdOf(panel)
            if (sid) live.add(sid)
          }
        }
        for (const sid of previousSessions) if (!live.has(sid)) killSession(sid)
        recountAll()
        recomputeLocalPanels()
        const mode = useWorkspaceModeStore.getState().mode
        activePanelRef.current = apiOfMode(mode, terminalApiRef.current, sshApiRef.current)?.activePanel
      } finally {
        applyTemplateInFlightRef.current = false
      }
    },
    [killSession, message, rebindRestoredPanels, recountAll, recomputeLocalPanels, retitleAutoPanels]
  )

  const handleDeleteTemplate = useCallback(async (meta: LayoutMetaLike): Promise<void> => {
    await window.api.deleteLayout(meta.id)
  }, [])

  /** [M5] Run a command in the currently active terminal/ssh session. */
  const runCommand = useCallback(
    (cmd: string): void => {
      const panel = activePanelRef.current
      if (!panel) {
        message.info(t('workspace.hint.noActiveTerminal'))
        return
      }
      const sid = sessionIdOf(panel)
      if (!sid) {
        message.info(t('workspace.hint.noSessionInPanel'))
        return
      }
      writeBroadcast(sid, `${cmd}\r`)
      panel.api.setActive()
    },
    [message]
  )

  // Memoized so the memoized IconRail below can actually bail out: the labels
  // are translated at build time, so `language` has to be a dependency or a
  // language switch would leave stale menu text behind.
  const language = useSettingsStore((s) => s.settings.system.language)

  // Auto tab titles are stored display text, so they have to be re-rendered on
  // a language switch — the rest of the UI re-renders itself. Skipped on mount
  // (a boot pass has not restored any panel yet, and a restored title is
  // retitled by the pass itself) and on every settings echo that leaves the
  // language untouched, which is the common case.
  const lastLanguageRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (lastLanguageRef.current === language) return
    const changed = lastLanguageRef.current !== undefined
    lastLanguageRef.current = language
    if (changed) retitleAutoPanels()
  }, [language, retitleAutoPanels])

  const layoutMenu = useMemo<MenuProps>(
    () => ({
      items: [
        { key: 'split-right', label: t('workspace.layout.splitRight') },
        { key: 'split-below', label: t('workspace.layout.splitBelow') },
        { type: 'divider' },
        { key: 'save', label: t('workspace.layout.saveTemplate') },
        { key: 'apply', label: t('workspace.layout.applyTemplate') }
      ],
      onClick: ({ key }) => {
        if (key === 'split-right') handleSplit('right')
        else if (key === 'split-below') handleSplit('below')
        else if (key === 'save') setSaveOpen(true)
        else if (key === 'apply') setApplyOpen(true)
      }
    }),
    [language, handleSplit]
  )

  return (
    <div className="workspace-root">
      <IconRail
        onOpenSettings={onOpenSettings}
        onNewTerminal={handleRailNewTerminal}
        onToggleSidebar={toggleSidebar}
        sidebarOpen={sidebarOpen}
        connecting={connecting}
        layoutMenu={layoutMenu}
      />
      <div className="workspace-body">
        {sidebarOpen && (
          <ConnectionSidebar
            ref={sidebarRef}
            className="connections-sidebar"
            onConnect={handleConnectRequest}
            localPanels={localPanels}
            activePanelId={activePanelId}
            onFocusPanel={onFocusPanel}
            onRunCommand={runCommand}
          />
        )}
        <div className="workspace-dockview">
          {/* Local-terminal workspace. */}
          <div className={workspaceMode === 'terminal' ? 'workspace-dockview-container' : 'workspace-dockview-container is-hidden'}>
            <DockviewReact
              className="dockview-theme-abyss"
              components={DOCKVIEW_COMPONENTS}
              tabComponents={DOCKVIEW_TAB_COMPONENTS}
              rightHeaderActionsComponent={TerminalTabActions}
              onReady={handleTerminalReady}
              theme={DOCKVIEW_THEME}
            />
            {terminalCount === 0 && (
              <div className="workspace-empty-overlay">
                <div className="workspace-empty-inner">
                  <div className="workspace-empty-title">{t('workspace.empty.terminalTitle')}</div>
                  <Button
                    type="primary"
                    size="small"
                    icon={<PlusOutlined />}
                    onClick={handleNewTerminal}
                  >
                    {t('workspace.newTerminal')}
                  </Button>
                </div>
              </div>
            )}
          </div>
          {/* SSH workspace. */}
          <div className={workspaceMode === 'ssh' ? 'workspace-dockview-container' : 'workspace-dockview-container is-hidden'}>
            <DockviewReact
              className="dockview-theme-abyss"
              components={DOCKVIEW_COMPONENTS}
              tabComponents={DOCKVIEW_TAB_COMPONENTS}
              rightHeaderActionsComponent={SshTabActions}
              onReady={handleSshReady}
              theme={DOCKVIEW_THEME}
            />
            {sshCount === 0 && (
              <div className="workspace-empty-overlay">
                <div className="workspace-empty-inner">
                  <div className="workspace-empty-title">{t('workspace.empty.sshTitle')}</div>
                  <div className="workspace-empty-hint">{t('workspace.empty.sshHint')}</div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* SSH connect flow: secret prompt (cancellable) → connecting modal (not). */}
      {requestedConn != null && (
        <ConnectFlow
          conn={requestedConn}
          phase={connecting ? 'connecting' : 'secret'}
          onConfirmed={handleSecretConfirmed}
          onCancel={handleConnectCancel}
        />
      )}

      {/* Host-key verification — head of the FIFO queue only. */}
      {hostKeyHead != null && (
        <HostKeyModal
          event={hostKeyHead}
          onDecision={(action) => handleHostKeyDecision(hostKeyHead.promptId, action)}
        />
      )}

      <SaveTemplateModal
        open={saveOpen}
        onCancel={() => setSaveOpen(false)}
        onConfirm={handleSaveTemplate}
      />
      <ApplyTemplateModal
        open={applyOpen}
        onClose={() => setApplyOpen(false)}
        onApply={handleApplyTemplate}
        onDelete={handleDeleteTemplate}
        list={() => window.api.listLayouts()}
      />
    </div>
  )
}

/** "＋" renders the new-terminal button (per-group tab addition). */
function AddTerminalGroupButton({ onClick }: { onClick: () => void }): React.JSX.Element {
  return (
    <button
      type="button"
      className="workspace-tabbar-add"
      title={t('workspace.tab.addInSplit')}
      aria-label={t('workspace.tab.addInSplit')}
      onClick={onClick}
    >
      <PlusOutlined />
    </button>
  )
}

/** 广播 target picker: toggle + Popover with per-session checkboxes. */
function BroadcastToggleButton(): React.JSX.Element {
  const enabled = useBroadcastStore((s) => s.enabled)
  const targets = useBroadcastStore((s) => s.targets)
  const sessions = useBroadcastStore((s) => s.sessions)
  const toggleTarget = useBroadcastStore((s) => s.toggleTarget)
  const setEnabled = useBroadcastStore((s) => s.setEnabled)
  /** M6.1: only the current workspace group's sessions are offered as targets. */
  const mode = useWorkspaceModeStore((s) => s.mode)

  const cls = [
    'workspace-tabbar-btn2',
    enabled ? ' is-active' : ''
  ].join('')
  return (
    <Popover
      trigger="click"
      placement="bottomRight"
      getPopupContainer={() => document.body}
      content={
        <WorkspaceBroadcastPopover
          mode={mode}
          enabled={enabled}
          targets={targets}
          sessions={sessions}
          onToggleTarget={toggleTarget}
          onSetEnabled={setEnabled}
        />
      }
    >
      <button
        type="button"
        className={cls}
        title={enabled ? t('workspace.broadcast.activeTitle', { count: targets.size }) : t('workspace.broadcast.toggle')}
        aria-label={t('workspace.broadcast.toggle')}
        aria-pressed={enabled}
      >
        <ShareAltOutlined />
        {enabled && <span className="workspace-tabbar-bcast-count">{targets.size}</span>}
      </button>
    </Popover>
  )
}

/** Popover body: list the current mode group's open sessions with a checkbox
 *  each; enable gate >= 2. Hidden-group targets stay in `targets` (the store
 *  doesn't care about visibility) but are not offered while in the other mode. */
function WorkspaceBroadcastPopover({
  mode,
  enabled,
  targets,
  sessions,
  onToggleTarget,
  onSetEnabled
}: {
  mode: WorkspaceMode
  enabled: boolean
  targets: Set<string>
  sessions: { id: string; title: string; isSsh: boolean }[]
  onToggleTarget: (id: string) => void
  onSetEnabled: (enabled: boolean) => void
}): React.JSX.Element {
  const isSsh = (s: { id: string; title: string; isSsh: boolean }): boolean => s.isSsh
  const groupSessions = sessions.filter((s) => (mode === 'ssh' ? isSsh(s) : !isSsh(s)))
  const label = (s: { id: string; title: string; isSsh: boolean }): string =>
    `${s.title}${s.isSsh ? ' (SSH)' : ''}`
  return (
    <div className="workspace-bcast-pop">
      <div className="workspace-bcast-pop-mode">
        {mode === 'ssh' ? t('workspace.broadcast.popoverSsh') : t('workspace.broadcast.popoverTerminal')}
      </div>
      <div className="workspace-bcast-pop-switch">
        <span className="workspace-bcast-pop-label">{t('workspace.broadcast.switch')}</span>
        <Checkbox
          checked={enabled}
          disabled={targets.size < 2}
          onChange={(e) => onSetEnabled(e.target.checked)}
        >
          {enabled
            ? t('workspace.broadcast.enabled', { count: targets.size })
            : targets.size < 2
              ? t('workspace.broadcast.needTwo')
              : t('workspace.broadcast.disabled')}
        </Checkbox>
      </div>
      <div className="workspace-bcast-pop-list">
        {groupSessions.length === 0 ? (
          <div className="workspace-bcast-pop-empty">
            {mode === 'ssh' ? t('workspace.broadcast.emptySsh') : t('workspace.broadcast.emptyTerminal')}
          </div>
        ) : (
          groupSessions.map((s) => (
            <div key={s.id} className="workspace-bcast-pop-item">
              <Checkbox checked={targets.has(s.id)} onChange={() => onToggleTarget(s.id)}>
                {label(s)}
              </Checkbox>
            </div>
          ))
        )}
      </div>
      <div className="workspace-bcast-pop-hint">{t('workspace.broadcast.hint')}</div>
    </div>
  )
}

/**
 * XTerminal-style slim icon rail on the left edge — replaces the top toolbar.
 * Top: workspace actions; bottom: settings.
 *
 * Memoized: the workspace re-renders on every session/panel change, and the
 * rail only depends on sidebar visibility, the connecting spinner and the
 * (memoized) layout menu, so the shallow compare lets it skip those renders.
 */
const IconRail = memo(function IconRail({
  onOpenSettings,
  onNewTerminal,
  onToggleSidebar,
  sidebarOpen,
  connecting,
  layoutMenu
}: {
  onOpenSettings: () => void
  onNewTerminal: () => void
  onToggleSidebar: () => void
  sidebarOpen: boolean
  connecting: boolean
  layoutMenu: MenuProps
}): React.JSX.Element {
  return (
    <div className="workspace-rail">
      <RailButton
        title={sidebarOpen ? t('workspace.rail.hideSidebar') : t('workspace.rail.showSidebar')}
        icon={sidebarOpen ? <MenuFoldOutlined /> : <MenuUnfoldOutlined />}
        onClick={onToggleSidebar}
      />
      <div className="workspace-rail-divider" />
      <RailButton title={t('workspace.newTerminal')} icon={<PlusOutlined />} onClick={onNewTerminal} />
      <LayoutFlyout menu={layoutMenu} />
      <div className="workspace-rail-divider" />
      <ModeRailButtons />
      <div className="workspace-rail-spacer" />
      {connecting && (
        <Tooltip title={t('workspace.rail.connecting')} placement="right">
          <span className="workspace-rail-busy" />
        </Tooltip>
      )}
      <RailButton title={t('workspace.rail.settings')} icon={<SettingOutlined />} onClick={onOpenSettings} />
    </div>
  )
})

/** M6.1: terminal / SSH workspace entries in the icon rail. */
function ModeRailButtons(): React.JSX.Element {
  const mode = useWorkspaceModeStore((s) => s.mode)
  const setMode = useWorkspaceModeStore((s) => s.setMode)
  return (
    <>
      <RailButton
        title={t('workspace.rail.terminalWorkspace')}
        icon={<CodeOutlined />}
        active={mode === 'terminal'}
        onClick={() => setMode('terminal')}
      />
      <RailButton
        title={t('workspace.rail.sshWorkspace')}
        icon={<CloudServerOutlined />}
        active={mode === 'ssh'}
        onClick={() => setMode('ssh')}
      />
    </>
  )
}

/**
 * Layout menu as an in-layout flyout panel. antd Dropdown portals to
 * document.body, where dockview's global pointer handling races it: the menu
 * painted over the rail and dismissed itself on open. This panel lives in the
 * rail's own stacking context, opens to the right of the rail, and closes only
 * on item pick, outside pointerdown, or Escape.
 */
const LayoutFlyout = memo(function LayoutFlyout({ menu }: { menu: MenuProps }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    return (): void => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const pick = (key: string): void => {
    setOpen(false)
    menu.onClick?.({ key, keyPath: [key] } as Parameters<NonNullable<MenuProps['onClick']>>[0])
  }

  return (
    <div className="workspace-flyout-anchor" ref={rootRef}>
      <Tooltip title={open ? '' : t('workspace.rail.layout')} placement="right">
        <button
          type="button"
          className={'workspace-rail-btn' + (open ? ' is-active' : '')}
          aria-label={t('workspace.rail.layout')}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <LayoutOutlined />
        </button>
      </Tooltip>
      {open && (
        <div className="workspace-flyout" role="menu">
          {(menu.items ?? []).map((item, i) => {
            if (!item) return null
            if (typeof item === 'string' || (item as { type?: unknown }).type === 'divider') {
              return <div key={`divider-${i}`} className="workspace-flyout-divider" />
            }
            const entry = item as { key?: React.Key; label?: ReactNode }
            if (entry.key === undefined) return null
            return (
              <button
                key={String(entry.key)}
                type="button"
                role="menuitem"
                className="workspace-flyout-item"
                onClick={() => pick(String(entry.key))}
              >
                {entry.label}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
})

function RailButton({
  title,
  icon,
  onClick,
  active,
  hideTooltip
}: {
  title: string
  icon: ReactNode
  onClick?: () => void
  active?: boolean
  hideTooltip?: boolean
}): React.JSX.Element {
  return (
    <Tooltip title={hideTooltip ? '' : title} placement="right">
      <button
        type="button"
        className={['workspace-rail-btn', active ? ' is-active' : ''].join('')}
        aria-label={title}
        aria-pressed={active}
        onClick={onClick}
      >
        {icon}
      </button>
    </Tooltip>
  )
}