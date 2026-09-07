import { useEffect, useRef, useState } from 'react'
import type { IDockviewPanelProps } from 'dockview-react'
import { Button } from 'antd'
import { AreaChartOutlined } from '@ant-design/icons'

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

  // M6 broadcast: keep the session in the broadcast registry while mounted so
  // it can be picked as a target / receive fan-out writes (idempotent upsert).
  useEffect(() => {
    useBroadcastStore.getState().registerSession({ id: sessionId, title: api.title ?? '', isSsh })
    return () => useBroadcastStore.getState().unregisterSession(sessionId)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- api is stable; title kept fresh below
  }, [sessionId])

  // M6: keep the registered broadcast title in sync with the tab title.
  useEffect(() => {
    const disposable = api.onDidTitleChange((event) => {
      useBroadcastStore.getState().registerSession({ id: sessionId, title: event.title, isSsh })
    })
    return () => disposable.dispose()
  }, [api, sessionId, isSsh])

  const terminal = (
    <TerminalView
      sessionId={sessionId}
      className="workspace-terminal-view"
      onClose={() => {
        if (closedRef.current) return
        closedRef.current = true
        onSessionDead?.(sessionId)
        api.close()
      }}
    />
  )

  return (
    <div className="workspace-terminal-panel">
      {isSsh && (
        <Button
          type="text"
          size="small"
          className="workspace-terminal-monitor-toggle"
          icon={<AreaChartOutlined />}
          aria-label={sideOpen ? '收起侧边栏' : '展开侧边栏'}
          title={sideOpen ? '收起侧边栏' : '展开侧边栏'}
          onClick={() => setSideOpen((prev) => !prev)}
        />
      )}
      <div className="workspace-terminal-split">
        {isSsh ? <SshBottomPanel sessionId={sessionId} terminal={terminal} /> : terminal}
        {isSsh && sideOpen && (
          <div className="workspace-terminal-side">
            <MonitorPanel sessionId={sessionId} />
          </div>
        )}
      </div>
    </div>
  )
}
