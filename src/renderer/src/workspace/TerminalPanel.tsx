import { useEffect, useRef, useState } from 'react'
import type { IDockviewPanelProps } from 'dockview-react'
import { Button } from 'antd'
import { AreaChartOutlined } from '@ant-design/icons'

import { tFor, DEFAULT_LANGUAGE } from '@shared/i18n'
import { useSettingsStore } from '@renderer/settings/store'
import { PanelErrorBoundary } from '../ErrorBoundary'
import { TerminalView } from '../terminal/TerminalView'
import { MonitorPanel } from '../monitor/MonitorPanel'
import { SshBottomPanel } from './SshBottomPanel'
import { useBroadcastStore } from './broadcastStore'
import type { TerminalParams } from './Workspace'

export interface TerminalPanelExtraProps {
  /**
   * Notifies the workspace that a session is already dead (its process
   * exited) so the panel close skips the pty kill.
   */
  onSessionDead?: (sessionId: string) => void
}

export type TerminalPanelProps = IDockviewPanelProps<TerminalParams> & TerminalPanelExtraProps

/**
 * Dockview content component registered as `'terminal'`.
 *
 * Binds the pty `sessionId` param to <TerminalView>. When the underlying
 * process exits, TerminalView calls `onClose` and we close the panel —
 * marking the session dead first so onDidRemovePanel won't try to kill an
 * already-exited process.
 *
 * For SSH sessions (`sessionKind === 'ssh'`) a collapsible right sidebar with
 * [系统监控] is docked next to the terminal, and a resizable file browser
 * (SshBottomPanel) sits below the terminal. Local sessions render terminal
 * only.
 */
export function TerminalPanel({ params, api, onSessionDead }: TerminalPanelProps): React.JSX.Element {
  const sessionId = params.sessionId ?? ''
  const sessionKind = params.sessionKind
  const isSsh = sessionKind === 'ssh'
  const closedRef = useRef(false)
  /** Right sidebar (monitor) visibility for ssh sessions — expanded by default. */
  const [sideOpen, setSideOpen] = useState(true)

  // dockview renders panel content from its own portal slot, so the panel never
  // re-renders as part of the App→Workspace tree; the language is subscribed
  // here and handed to `tFor` explicitly rather than read from the module-level
  // language that `t()` uses.
  const language = useSettingsStore((s) => s.settings.system.language ?? DEFAULT_LANGUAGE)

  // M6 broadcast: keep the session in the broadcast registry while mounted so
  // it can be picked as a target / receive fan-out writes. Registrations are
  // keyed by panel id — an SSH split shows one session in two panes, and
  // unmounting one of them must not unregister the other.
  useEffect(() => {
    useBroadcastStore
      .getState()
      .registerSession({ id: sessionId, panelId: api.id, title: api.title ?? '', isSsh })
    return () => useBroadcastStore.getState().unregisterSession(api.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- api is stable; title kept fresh below
  }, [sessionId])

  // M6: keep the registered broadcast title in sync with the tab title.
  useEffect(() => {
    const disposable = api.onDidTitleChange((event) => {
      useBroadcastStore
        .getState()
        .registerSession({ id: sessionId, panelId: api.id, title: event.title, isSsh })
    })
    return () => disposable.dispose()
  }, [api, sessionId, isSsh])

  const terminal = (
    <TerminalView
      sessionId={sessionId}
      isSsh={isSsh}
      connectionId={params.connectionId}
      className="workspace-terminal-view"
      onClose={() => {
        if (closedRef.current) return
        closedRef.current = true
        onSessionDead?.(sessionId)
        api.close()
      }}
    />
  )

  // A crash inside one pane must not take the workspace — and every other live
  // session — down to the root boundary's reload screen. The pane's own content
  // is remounted on retry; the shell (tab, broadcast registration) survives.
  return (
    <div className="workspace-terminal-panel">
      <PanelErrorBoundary label={tFor(language, 'workspace.error.panelTitle')}>
        {isSsh && (
          <Button
            type="text"
            size="small"
            className="workspace-terminal-monitor-toggle"
            icon={<AreaChartOutlined />}
            aria-label={sideOpen ? tFor(language, 'workspace.panel.hideSidebar') : tFor(language, 'workspace.panel.showSidebar')}
            title={sideOpen ? tFor(language, 'workspace.panel.hideSidebar') : tFor(language, 'workspace.panel.showSidebar')}
            onClick={() => setSideOpen((prev) => !prev)}
          />
        )}
        <div className="workspace-terminal-split">
          {isSsh ? <SshBottomPanel sessionId={sessionId} terminal={terminal} language={language} /> : terminal}
          {isSsh && sideOpen && (
            <div className="workspace-terminal-side">
              <MonitorPanel sessionId={sessionId} />
            </div>
          )}
        </div>
      </PanelErrorBoundary>
    </div>
  )
}
