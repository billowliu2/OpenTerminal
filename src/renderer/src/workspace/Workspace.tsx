import { useCallback, useEffect, useRef, useState } from 'react'
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
  ShareAltOutlined,
  ThunderboltOutlined
} from '@ant-design/icons'
import { DockviewReact } from 'dockview-react'
import type {
  DockviewApi,
  DockviewReadyEvent,
  IDockviewHeaderActionsProps,
  IDockviewPanel,
  IDockviewPanelHeaderProps,
  IDockviewPanelProps
} from 'dockview-react'
import 'dockview-react/dist/styles/dockview.css'

import type { HostKeyPromptEvent, SshConnection, SshSecretOverride } from '@shared/connections'
import { ConnectionSidebar } from '../connections/ConnectionSidebar'
import type { ConnectionSidebarHandle } from '../connections/ConnectionSidebar'
import { ConnectFlow } from './ConnectFlow'
import { HostKeyModal } from './HostKeyModal'
import { TerminalPanel } from './TerminalPanel'
import { ApplyTemplateModal, SaveTemplateModal, TerminalTab } from './TerminalTab'
import { useBroadcastStore, writeBroadcast } from './broadcastStore'
import { QuickInputPanel, useQuickInputStore } from './QuickInputPanel'
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
}

export type { TerminalParams }

const TERMINAL_COMPONENT = 'terminal'
const TERMINAL_TAB_COMPONENT = 'terminal-tab'

/**
 * Per-workspace monotonic title counter for "终端 N". Lives on `window` so
 * dev hot-reloads (which reset module state) don't restart the numbering and
 * produce duplicate tab titles.
 */
const titleSeqHolder = window as unknown as { __otTitleSeq?: number }
function nextTerminalTitle(): string {
  titleSeqHolder.__otTitleSeq = (titleSeqHolder.__otTitleSeq ?? 0) + 1
  return `终端 ${titleSeqHolder.__otTitleSeq}`
}

function sessionIdOf(panel: IDockviewPanel): string | undefined {
  return (panel.params as TerminalParams | undefined)?.sessionId
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
        message.info('SSH 会话请从服务器列表连接')
        return
      }
      void (async (): Promise<void> => {
        const result = await window.api.createPty()
        containerApi.addPanel<TerminalParams>({
          id: result.id,
          component: TERMINAL_COMPONENT,
          tabComponent: TERMINAL_TAB_COMPONENT,
          title: nextTerminalTitle(),
          params: { sessionId: result.id, sessionKind: 'local' },
          position: { referenceGroup: group.id, direction: 'within' }
        })
      })()
    }

    return (
      <div className="workspace-tabbar-actions">
        <AddTerminalGroupButton onClick={handleAdd} />
        <BroadcastToggleButton />
        <QuickInputToggleButton />
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
 * through `deadSessionsRef` so a session is killed at most once — either
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
  /** The currently-visible mode's active panel (broadcast / quick-input target). */
  const activePanelRef = useRef<IDockviewPanel | undefined>(undefined)

  /** Sessions we already asked to kill — kill once, never twice. */
  const deadSessionsRef = useRef<Set<string>>(new Set())
  /** Bind-time disposables for both dockviews, disposed on unmount. */
  const disposablesRef = useRef<Array<{ dispose(): void }>>([])

  const [saveOpen, setSaveOpen] = useState(false)
  const [applyOpen, setApplyOpen] = useState(false)
  /** Terminal dockview ready — gates first-run seeding. */
  const [terminalReady, setTerminalReady] = useState(false)

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
  /** true while openSession is in flight — drives the "连接中…" modal. */
  const [connecting, setConnecting] = useState(false)
  /** FIFO of pending host-key confirmations — render the head only. */
  const [hostKeyQueue, setHostKeyQueue] = useState<HostKeyPromptEvent[]>([])

  /** B's sidebar handle; refresh() after a successful SSH connect */
  const sidebarRef = useRef<ConnectionSidebarHandle>(null)

  /** Idempotently kill a pty session. */
  const killSession = useCallback((sessionId: string | undefined): void => {
    if (!sessionId) return
    if (deadSessionsRef.current.has(sessionId)) return
    deadSessionsRef.current.add(sessionId)
    window.api.killPty(sessionId)
  }, [])

  /** Mark a session dead ahead of a panel close so the cleanup skips it. */
  const markSessionDead = useCallback((sessionId: string): void => {
    deadSessionsRef.current.add(sessionId)
  }, [])

  const createSession = useCallback(async (): Promise<string> => {
    const result = await window.api.createPty()
    return result.id
  }, [])

  /** Rebuild the local-terminal list for the sidebar's "终端" section. The
   *  terminal dockview holds only local sessions, so it is the single source. */
  const recomputeLocalPanels = useCallback((): void => {
    const current = terminalApiRef.current
    if (!current) {
      setLocalPanels([])
      return
    }
    const panels = current.panels
      .filter((p) => (p.params as TerminalParams | undefined)?.sessionKind === 'local')
      .map((p) => ({ id: p.id, title: p.title ?? '' }))
    setLocalPanels(panels)
  }, [])

  /** Recount session panels per dockview into local state. */
  const recountAll = useCallback((): void => {
    const terminal = terminalApiRef.current
    const ssh = sshApiRef.current
    const t = terminal ? terminal.panels.filter((p) => sessionIdOf(p)).length : 0
    const s = ssh ? ssh.panels.filter((p) => sessionIdOf(p)).length : 0
    setModeCounts((prev) => (prev.terminal === t && prev.ssh === s ? prev : { terminal: t, ssh: s }))
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

      const cleanups = [
        api.onDidRemovePanel((panel: IDockviewPanel) => {
          killSession(sessionIdOf(panel))
          recomputeLocalPanels()
          recountAll()
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
        }),
        api.onDidAddPanel(() => recountAll())
      ]
      disposablesRef.current.push(...cleanups)
    },
    [killSession, recomputeLocalPanels, recountAll]
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

  /** First run: seed one local terminal so the terminal workspace is never
   *  empty on launch. Runs once, after the terminal dockview is ready. */
  useEffect(() => {
    if (!terminalReady) return
    const current = terminalApiRef.current
    if (current && !current.panels.some((p) => sessionIdOf(p))) void addTerminal()
    // seed the terminal workspace exactly once, on first ready
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalReady])

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
      setHostKeyQueue((prev) => [...prev, event])
    })
  }, [])

  const hostKeyHead = hostKeyQueue.length > 0 ? hostKeyQueue[0] : null

  const handleHostKeyDecision = useCallback((action: 'accept' | 'reject'): void => {
    // The queue head's decision is final (accept/reject both consume the prompt).
    setHostKeyQueue((prev) => {
      const head = prev[0]
      if (!head) return prev
      window.api.respondHostKey(head.promptId, action)
      return prev.slice(1)
    })
  }, [])

  /**
   * M6: Ctrl+PgUp / Ctrl+PgDn cycle tabs. Registered on `window` with
   * capture:true so it runs before xterm's own key handling; it only cycles the
   * currently-visible workspace's session panels.
   */
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
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
      const sessionId = await createSession()
      const reference = activeTerminalPanelRef.current

      current.addPanel<TerminalParams>({
        id: sessionId,
        component: TERMINAL_COMPONENT,
        tabComponent: TERMINAL_TAB_COMPONENT,
        title: nextTerminalTitle(),
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
   */
  const connect = useCallback(
    async (conn: SshConnection, secretOverride: SshSecretOverride): Promise<void> => {
      setConnecting(true)
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
          id: result.id,
          component: TERMINAL_COMPONENT,
          tabComponent: TERMINAL_TAB_COMPONENT,
          title: conn.name,
          params: { sessionId: result.id, sessionKind: 'ssh', hostLabel: conn.host }
        })
        // B's sidebar refreshes lastConnectedAt on connect.
        void sidebarRef.current?.refresh()
      } catch (error) {
        message.error(typeof error === 'string' ? error : 'SSH 连接失败')
      } finally {
        setConnecting(false)
        setRequestedConn(null)
      }
    },
    [message]
  )

  const handleConnectRequest = useCallback(
    (conn: SshConnection): void => {
      // Ask-at-connect connections go through the secret prompt first; saved
      // credentials must connect IMMEDIATELY — routing them through ConnectFlow
      // would only ever *render* a "connecting" spinner without firing openSession.
      const needsPassword = conn.auth === 'password' && conn.askPasswordAtConnect
      const needsPassphrase = conn.auth === 'privateKey' && conn.askPassphraseAtConnect
      if (needsPassword || needsPassphrase) {
        setRequestedConn(conn)
        return
      }
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
      message.info('SSH 会话请从服务器列表连接')
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
        message.info('请先连接 SSH 服务器')
        return
      }
      const reference = activeSshPanelRef.current
      if (!reference || !current) return
      const sessionId = sessionIdOf(reference)
      if (!sessionId) return
      const refParams = reference.params as TerminalParams | undefined
      current.addPanel<TerminalParams>({
        id: `ssh-${sessionId}-${window.crypto.randomUUID().slice(0, 8)}`,
        component: TERMINAL_COMPONENT,
        tabComponent: TERMINAL_TAB_COMPONENT,
        title: reference.title,
        params: { sessionId, sessionKind: 'ssh', hostLabel: refParams?.hostLabel },
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
   * Rebind every restored session panel to a fresh local pty. Templates cannot
   * carry live session state (SSH needs credentials not stored in the layout),
   * so sessions are recreated as local terminals in whichever workspace the
   * layout put them.
   */
  const rebindRestoredPanels = useCallback(
    async (api: DockviewApi): Promise<void> => {
      for (const panel of api.panels) {
        const id = sessionIdOf(panel)
        if (id && panel.view.contentComponent === TERMINAL_COMPONENT) {
          const newSessionId = (await window.api.createPty()).id
          panel.api.updateParameters({ sessionId: newSessionId, sessionKind: 'local' })
          deadSessionsRef.current.delete(id)
        }
      }
    },
    []
  )

  const handleApplyTemplate = useCallback(
    async (meta: LayoutMetaLike): Promise<void> => {
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
      } catch {
        return
      }
      const payload = parsed as { terminal?: unknown; ssh?: unknown }
      const hasDualLayout = payload !== null && typeof payload === 'object' && 'terminal' in payload && 'ssh' in payload

      // Dual layout (M6.1+): restore each dockview from its own payload.
      // Legacy layout (pre-M6.1 single toJSON): restore it wholly into the
      // terminal dockview.
      if (hasDualLayout) {
        terminalApiRef.current?.fromJSON(payload.terminal as never)
        sshApiRef.current?.fromJSON(payload.ssh as never)
      } else {
        // Legacy single-dockview layout → restore into the terminal workspace.
        terminalApiRef.current?.fromJSON((payload as unknown) as never)
      }

      // Fresh sessions for every restored terminal panel in both workspaces.
      if (terminalApiRef.current) await rebindRestoredPanels(terminalApiRef.current)
      if (sshApiRef.current) await rebindRestoredPanels(sshApiRef.current)

      // Old sessions are unreachable after the layout swap — kill them.
      for (const sid of previousSessions) killSession(sid)
      recountAll()
      recomputeLocalPanels()
      const mode = useWorkspaceModeStore.getState().mode
      activePanelRef.current = apiOfMode(mode, terminalApiRef.current, sshApiRef.current)?.activePanel
    },
    [killSession, rebindRestoredPanels, recountAll, recomputeLocalPanels]
  )

  const handleDeleteTemplate = useCallback(async (meta: LayoutMetaLike): Promise<void> => {
    await window.api.deleteLayout(meta.id)
  }, [])

  /** [M5] Run a command in the currently active terminal/ssh session. */
  const runCommand = useCallback(
    (cmd: string): void => {
      const panel = activePanelRef.current
      if (!panel) {
        message.info('没有激活的终端：请至少打开一个本地终端或 SSH 会话')
        return
      }
      const sid = sessionIdOf(panel)
      if (!sid) {
        message.info('当前激活面板没有可用的会话')
        return
      }
      writeBroadcast(sid, `${cmd}\r`)
      panel.api.setActive()
    },
    [message]
  )

  const layoutMenu: MenuProps = {
    items: [
      { key: 'split-right', label: '水平分屏' },
      { key: 'split-below', label: '垂直分屏' },
      { type: 'divider' },
      { key: 'save', label: '保存为模板' },
      { key: 'apply', label: '应用模板' }
    ],
    onClick: ({ key }) => {
      if (key === 'split-right') handleSplit('right')
      else if (key === 'split-below') handleSplit('below')
      else if (key === 'save') setSaveOpen(true)
      else if (key === 'apply') setApplyOpen(true)
    }
  }

  /** Session id of the currently active, visible terminal panel ('' when none). */
  const resolveActiveSessionId = useCallback((): string => {
    const panel = activePanelRef.current
    if (!panel) return ''
    return sessionIdOf(panel) ?? ''
  }, [])

  return (
    <div className="workspace-root">
      <IconRail
        onOpenSettings={onOpenSettings}
        onNewTerminal={handleRailNewTerminal}
        onSplit={handleSplit}
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
              components={{
                [TERMINAL_COMPONENT]: (props: IDockviewPanelProps<TerminalParams>) => (
                  <TerminalPanel {...props} onSessionDead={markSessionDead} />
                )
              }}
              tabComponents={{
                [TERMINAL_TAB_COMPONENT]: (props: IDockviewPanelHeaderProps<TerminalParams>) => (
                  <TerminalTab {...props} />
                )
              }}
              rightHeaderActionsComponent={TerminalTabActions}
              onReady={handleTerminalReady}
              theme={{ name: 'Abyss', className: 'dockview-theme-abyss', colorScheme: 'dark' }}
            />
            {terminalCount === 0 && (
              <div className="workspace-empty-overlay">
                <div className="workspace-empty-inner">
                  <div className="workspace-empty-title">暂无终端</div>
                  <Button
                    type="primary"
                    size="small"
                    icon={<PlusOutlined />}
                    onClick={handleNewTerminal}
                  >
                    新建终端
                  </Button>
                </div>
              </div>
            )}
          </div>
          {/* SSH workspace. */}
          <div className={workspaceMode === 'ssh' ? 'workspace-dockview-container' : 'workspace-dockview-container is-hidden'}>
            <DockviewReact
              className="dockview-theme-abyss"
              components={{
                [TERMINAL_COMPONENT]: (props: IDockviewPanelProps<TerminalParams>) => (
                  <TerminalPanel {...props} onSessionDead={markSessionDead} />
                )
              }}
              tabComponents={{
                [TERMINAL_TAB_COMPONENT]: (props: IDockviewPanelHeaderProps<TerminalParams>) => (
                  <TerminalTab {...props} />
                )
              }}
              rightHeaderActionsComponent={SshTabActions}
              onReady={handleSshReady}
              theme={{ name: 'Abyss', className: 'dockview-theme-abyss', colorScheme: 'dark' }}
            />
            {sshCount === 0 && (
              <div className="workspace-empty-overlay">
                <div className="workspace-empty-inner">
                  <div className="workspace-empty-title">暂无 SSH 会话</div>
                  <div className="workspace-empty-hint">请从左侧服务器列表连接</div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* M6: floating quick-input panel (bottom-right). Sends to the active
          session; broadcast target → fan-out. Sits above the sftp transfer
          overlay's 14px bottom offset so the two never overlap. */}
      <QuickInputPanel onResolveActiveSession={resolveActiveSessionId} />

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
        <HostKeyModal event={hostKeyHead} onDecision={handleHostKeyDecision} />
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
      title="在此分屏中新建终端"
      aria-label="在此分屏中新建终端"
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
        title={enabled ? `广播中 (${targets.size} 个目标)` : '广播输入'}
        aria-label="广播输入"
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
      <div className="workspace-bcast-pop-mode">广播输入（{mode === 'ssh' ? 'SSH' : '终端'}）</div>
      <div className="workspace-bcast-pop-switch">
        <span className="workspace-bcast-pop-label">广播开关</span>
        <Checkbox
          checked={enabled}
          disabled={targets.size < 2}
          onChange={(e) => onSetEnabled(e.target.checked)}
        >
          {enabled ? `已启用 (${targets.size})` : targets.size < 2 ? '需至少选择 2 个目标' : '未启用'}
        </Checkbox>
      </div>
      <div className="workspace-bcast-pop-list">
        {groupSessions.length === 0 ? (
          <div className="workspace-bcast-pop-empty">
            {mode === 'ssh' ? '暂无 SSH 服务器会话' : '暂无终端'}
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
      <div className="workspace-bcast-pop-hint">选择 ≥2 个终端后广播自动开启；关闭任意一个使目标少于 2 个时自动关闭。仅当前模式组的会话可被勾选。</div>
    </div>
  )
}

/** 快捷输入 panel toggle (ThunderboltOutlined) — state lives in the shared store. */
function QuickInputToggleButton(): React.JSX.Element {
  const toggle = useQuickInputStore((s) => s.toggle)
  const open = useQuickInputStore((s) => s.open)
  return (
    <Tooltip title={open ? '收起快捷输入面板' : '打开快捷输入面板'}>
      <button
        type="button"
        className={['workspace-tabbar-btn2', open ? ' is-active' : ''].join('')}
        aria-label="快捷输入面板"
        aria-pressed={open}
        onClick={toggle}
      >
        <ThunderboltOutlined />
      </button>
    </Tooltip>
  )
}

/**
 * XTerminal-style slim icon rail on the left edge — replaces the top toolbar.
 * Top: workspace actions; bottom: settings.
 */
function IconRail({
  onOpenSettings,
  onNewTerminal,
  onSplit,
  onToggleSidebar,
  sidebarOpen,
  connecting,
  layoutMenu
}: {
  onOpenSettings: () => void
  onNewTerminal: () => void
  onSplit: (direction: 'right' | 'below') => void
  onToggleSidebar: () => void
  sidebarOpen: boolean
  connecting: boolean
  layoutMenu: MenuProps
}): React.JSX.Element {
  return (
    <div className="workspace-rail">
      <RailButton
        title={sidebarOpen ? '收起侧栏' : '展开侧栏'}
        icon={sidebarOpen ? <MenuFoldOutlined /> : <MenuUnfoldOutlined />}
        onClick={onToggleSidebar}
      />
      <div className="workspace-rail-divider" />
      <RailButton title="新建终端" icon={<PlusOutlined />} onClick={onNewTerminal} />
      <LayoutFlyout menu={layoutMenu} />
      <div className="workspace-rail-divider" />
      <ModeRailButtons />
      <div className="workspace-rail-spacer" />
      {connecting && (
        <Tooltip title="正在连接…" placement="right">
          <span className="workspace-rail-busy" />
        </Tooltip>
      )}
      <RailButton title="设置" icon={<SettingOutlined />} onClick={onOpenSettings} />
    </div>
  )
}

/** M6.1: terminal / SSH workspace entries in the icon rail. */
function ModeRailButtons(): React.JSX.Element {
  const mode = useWorkspaceModeStore((s) => s.mode)
  const setMode = useWorkspaceModeStore((s) => s.setMode)
  return (
    <>
      <RailButton
        title="终端工作区"
        icon={<CodeOutlined />}
        active={mode === 'terminal'}
        onClick={() => setMode('terminal')}
      />
      <RailButton
        title="SSH 工作区"
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
function LayoutFlyout({ menu }: { menu: MenuProps }): React.JSX.Element {
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
      <Tooltip title={open ? '' : '布局'} placement="right">
        <button
          type="button"
          className={'workspace-rail-btn' + (open ? ' is-active' : '')}
          aria-label="布局"
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
}

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