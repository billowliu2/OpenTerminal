import { forwardRef, useEffect, useImperativeHandle, useMemo, useState } from 'react'
import { Button, Collapse, Popconfirm, Tooltip } from 'antd'
import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons'
import type { SshConnection } from '@shared/connections'
import { t } from '@shared/i18n'
import { AuthTags } from './Common'
import { ConnectionEditDialog } from './ConnectionEditDialog'
import { CommandsPanel } from '../commands/CommandsPanel'
import { useWorkspaceModeStore } from '../workspace/workspaceModeStore'
import './connections.css'
import '../workspace/workspace.css'

export interface ConnectionSidebarProps {
  className?: string
  /** called when the user double-clicks a connection (or clicks a recent session) */
  onConnect: (conn: SshConnection) => void
  /** open local terminal panels fed by the workspace ("终端" section). */
  localPanels?: Array<{ id: string; title: string }>
  /** id of the currently active panel in the workspace, for highlighting. */
  activePanelId?: string | null
  /** focus a local terminal panel; e.g. dockview api.getPanel(id)?.setActive(). */
  onFocusPanel?: (panelId: string) => void
  /** [M5] run a command in the workspace's currently active panel. */
  onRunCommand?: (cmd: string) => void
}

export interface ConnectionSidebarHandle {
  /** reload the connection list from main */
  refresh: () => Promise<void>
}

/** Short human "time ago" for the recent-session rows. */
function formatRelativeTime(ts: number): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (diffSec < 60) return t('ssh.sidebar.timeJustNow')
  const mins = Math.floor(diffSec / 60)
  if (mins < 60) return t('ssh.sidebar.timeMinutesAgo', { n: mins })
  const hours = Math.floor(mins / 60)
  if (hours < 24) return t('ssh.sidebar.timeHoursAgo', { n: hours })
  const days = Math.floor(hours / 24)
  if (days < 30) return t('ssh.sidebar.timeDaysAgo', { n: days })
  return new Date(ts).toLocaleDateString()
}

/**
 * Left-hand SSH bookmark sidebar (XTerminal server-list style).
 *
 * Refresh contract: the parent may call `useRef<ConnectionSidebarHandle>()` and
 * invoke `refresh()` after opening an SSH session elsewhere (e.g. to update
 * `lastConnectedAt`), or simply remount the component with a `key`.
 */
export const ConnectionSidebar = forwardRef<ConnectionSidebarHandle, ConnectionSidebarProps>(
  function ConnectionSidebar(
    {
      className,
      onConnect,
      localPanels = [],
      activePanelId,
      onFocusPanel,
      onRunCommand
    }: ConnectionSidebarProps,
    ref
  ): React.JSX.Element {
    const mode = useWorkspaceModeStore((s) => s.mode)
    const isTerminal = mode === 'terminal'
    const [connections, setConnections] = useState<SshConnection[]>([])
    const [loaded, setLoaded] = useState(false)
    const [dialogOpen, setDialogOpen] = useState(false)
    const [editing, setEditing] = useState<SshConnection | null>(null)

    const refresh = async (): Promise<void> => {
      try {
        const conns = await window.api.listConnections()
        setConnections(conns)
      } catch {
        setConnections([])
      } finally {
        setLoaded(true)
      }
    }

    useImperativeHandle(ref, () => ({ refresh }), [refresh])

    useEffect(() => {
      void refresh()
    }, [])

    // Fold every group open by default; only the user's collapses are stored,
    // so a group that appears later starts open as well.
    const defaultGroup = t('ssh.sidebar.defaultGroup')
    const [closedGroups, setClosedGroups] = useState<string[]>([])

    const groups = useMemo(() => {
      const map = new Map<string, SshConnection[]>()
      for (const c of connections) {
        const key = c.group ?? defaultGroup
        const list = map.get(key)
        if (list) list.push(c)
        else map.set(key, [c])
      }
      const entries = [...map.entries()].sort((a, b) => {
        if (a[0] === defaultGroup) return -1
        if (b[0] === defaultGroup) return 1
        return a[0].localeCompare(b[0])
      })
      return entries.map(([group, list]) => ({ group, list }))
    }, [connections, defaultGroup])

    const openCreate = (): void => {
      setEditing(null)
      setDialogOpen(true)
    }

    const openEdit = (conn: SshConnection): void => {
      setEditing(conn)
      setDialogOpen(true)
    }

    const handleDelete = async (id: string): Promise<void> => {
      await window.api.deleteConnection(id)
      await refresh()
    }

    const handleSaved = (): void => {
      void refresh()
    }

    // Most-recently-connected servers (top 5, most recent first). The active
    // connection list must be consulted so the row renders its auth badge etc.
    const recent = useMemo(() => {
      return connections
        .filter((c) => typeof c.lastConnectedAt === 'number')
        .sort((a, b) => (b.lastConnectedAt as number) - (a.lastConnectedAt as number))
        .slice(0, 5)
    }, [connections])

    const collapseItems = groups.map(({ group, list }) => ({
      key: group,
      label: (
        <div className="connections-group-head">
          <span className="connections-group-name">{group}</span>
          <span className="connections-group-count">{list.length}</span>
        </div>
      ),
      children: (
        <div className="connections-group-body">
          {list.map((conn) => (
            <Row
              key={conn.id}
              conn={conn}
              onDoubleClick={() => onConnect(conn)}
              onEdit={() => openEdit(conn)}
              onDelete={() => void handleDelete(conn.id)}
            />
          ))}
        </div>
      )
    }))

    return (
      <aside className={className ?? 'connections-sidebar'}>
        <div className="connections-mode-title">
          {isTerminal ? t('ssh.sidebar.modeTerminal') : t('ssh.sidebar.modeSsh')}
        </div>
        <div className="connections-header">
          <span className="connections-title">{t('ssh.sidebar.title')}</span>
          <Button
            type="text"
            size="small"
            icon={<PlusOutlined />}
            onClick={openCreate}
            aria-label={t('ssh.sidebar.newConnection')}
          />
        </div>

        <div className="connections-list">
        {isTerminal && (
        <section className="connections-section">
          <div className="connections-section-head">
            <span className="connections-section-title">{t('ssh.sidebar.sectionTerminals')}</span>
            <span className="connections-section-count">{localPanels.length}</span>
          </div>
          {localPanels.length === 0 ? (
            <div className="connections-section-empty">{t('ssh.sidebar.noLocalTerminals')}</div>
          ) : (
            <ul className="connections-local-list">
              {localPanels.map((panel) => (
                <li
                  key={panel.id}
                  className={`connections-local-item${panel.id === activePanelId ? ' is-active' : ''}`}
                  onClick={() => onFocusPanel?.(panel.id)}
                  title={panel.title}
                >
                  <span className="connections-local-name">{panel.title}</span>
                  <span className="connections-local-tag">{t('ssh.sidebar.local')}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
        )}

        {!isTerminal && (
        <section className="connections-section">
          <div className="connections-section-head">
            <span className="connections-section-title">{t('ssh.sidebar.sectionServers')}</span>
          </div>
          {connections.length === 0 ? (
            <div className="connections-empty">
              {loaded ? (
                <button type="button" className="connections-empty-create" onClick={openCreate}>
                  {t('ssh.sidebar.empty')}
                </button>
              ) : (
                <span>{t('ssh.sidebar.loading')}</span>
              )}
            </div>
          ) : (
            <Collapse
              ghost
              className="connections-collapse"
              items={collapseItems}
              activeKey={groups.map((g) => g.group).filter((key) => !closedGroups.includes(key))}
              onChange={(keys) =>
                setClosedGroups(groups.map((g) => g.group).filter((key) => !keys.includes(key)))
              }
            />
          )}

          {recent.length > 0 && (
            <div className="connections-recent">
              <div className="connections-recent-head">
                <span className="connections-recent-title">{t('ssh.sidebar.recent')}</span>
              </div>
              {recent.map((conn) => (
                <button
                  key={conn.id}
                  type="button"
                  className="connections-recent-item"
                  onClick={() => onConnect(conn)}
                  title={`${conn.name} · ${new Date(conn.lastConnectedAt as number).toLocaleString()}`}
                >
                  <span className="connections-recent-name">{conn.name}</span>
                  <span className="connections-recent-time">
                    {formatRelativeTime(conn.lastConnectedAt as number)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>
        )}

        {isTerminal && (
        <section className="connections-section commands-sidebar-section">
          <div className="connections-section-head">
            <span className="connections-section-title">{t('panels.commands.sectionTitle')}</span>
          </div>
          <CommandsPanel onRun={onRunCommand ?? ((): void => undefined)} />
        </section>
        )}
      </div>

        <ConnectionEditDialog
          open={dialogOpen}
          editing={editing}
          onClose={() => setDialogOpen(false)}
          onSaved={handleSaved}
        />
      </aside>
    )
  }
)

function Row({
  conn,
  onDoubleClick,
  onEdit,
  onDelete
}: {
  conn: SshConnection
  onDoubleClick: () => void
  onEdit: () => void
  onDelete: () => void
}): React.JSX.Element {
  const [confirming, setConfirming] = useState(false)
  return (
    <div className="connections-row" onDoubleClick={onDoubleClick} title={`${conn.username}@${conn.host}:${conn.port}`}>
      <div className="connections-row-main">
        <div className="connections-row-name">
          <span className="connections-row-label">{conn.name}</span>
          <Tooltip title={conn.host === conn.host ? t('ssh.sidebar.dblClickConnect', { host: conn.host }) : undefined}>
            <AuthTags auth={conn.auth} />
          </Tooltip>
        </div>
        <div className="connections-row-sub">
          {conn.group ? `${conn.group} · ` : ''}
          {conn.host}:{conn.port} · {conn.username}
        </div>
      </div>
      <div className="connections-row-actions">
        <Button type="text" size="small" icon={<EditOutlined />} onClick={onEdit} aria-label={t('common.edit')} />
        <Popconfirm
          title={t('ssh.sidebar.deleteTitle')}
          description={t('ssh.sidebar.deleteDesc')}
          okText={t('common.delete')}
          cancelText={t('common.cancel')}
          okButtonProps={{ danger: true }}
          open={confirming}
          onConfirm={onDelete}
          onOpenChange={(visible) => setConfirming(visible)}
          onCancel={() => setConfirming(false)}
        >
          <Button size="small" type="text" danger icon={<DeleteOutlined />} aria-label={t('common.delete')} />
        </Popconfirm>
      </div>
    </div>
  )
}