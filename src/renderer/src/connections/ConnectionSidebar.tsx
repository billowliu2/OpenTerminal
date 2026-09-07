import { forwardRef, useEffect, useImperativeHandle, useMemo, useState } from 'react'
import { Button, Collapse, Popconfirm, Tooltip } from 'antd'
import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons'
import type { SshConnection } from '@shared/connections'
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

const DEFAULT_GROUP = '默认'

/** Short human "time ago" for the recent-session rows. */
function formatRelativeTime(ts: number): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (diffSec < 60) return '刚刚'
  const mins = Math.floor(diffSec / 60)
  if (mins < 60) return `${mins} 分钟前`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} 天前`
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

    // Fold every group open whenever the dataset changes.
    const activeGroups = useMemo(() => {
      const groups = new Set<string>()
      for (const c of connections) groups.add(c.group ?? DEFAULT_GROUP)
      return [...groups]
    }, [connections])

    const groups = useMemo(() => {
      const map = new Map<string, SshConnection[]>()
      for (const c of connections) {
        const key = c.group ?? DEFAULT_GROUP
        const list = map.get(key)
        if (list) list.push(c)
        else map.set(key, [c])
      }
      const entries = [...map.entries()].sort((a, b) => {
        if (a[0] === DEFAULT_GROUP) return -1
        if (b[0] === DEFAULT_GROUP) return 1
        return a[0].localeCompare(b[0])
      })
      return entries.map(([group, list]) => ({ group, list }))
    }, [connections])

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
          {isTerminal ? '终端工作区' : 'SSH 工作区'}
        </div>
        <div className="connections-header">
          <span className="connections-title">连接</span>
          <Button
            type="text"
            size="small"
            icon={<PlusOutlined />}
            onClick={openCreate}
            aria-label="新建连接"
          />
        </div>

        <div className="connections-list">
        {isTerminal && (
        <section className="connections-section">
          <div className="connections-section-head">
            <span className="connections-section-title">终端</span>
            <span className="connections-section-count">{localPanels.length}</span>
          </div>
          {localPanels.length === 0 ? (
            <div className="connections-section-empty">无打开的本地终端</div>
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
                  <span className="connections-local-tag">本地</span>
                </li>
              ))}
            </ul>
          )}
        </section>
        )}

        {!isTerminal && (
        <section className="connections-section">
          <div className="connections-section-head">
            <span className="connections-section-title">SSH 服务器</span>
          </div>
          {connections.length === 0 ? (
            <div className="connections-empty">
              {loaded ? (
                <button type="button" className="connections-empty-create" onClick={openCreate}>
                  暂无连接，点击＋新建
                </button>
              ) : (
                <span>加载中…</span>
              )}
            </div>
          ) : (
            <Collapse
              ghost
              className="connections-collapse"
              items={collapseItems}
              defaultActiveKey={groups.map((g) => g.group)}
              activeKey={activeGroups}
            />
          )}

          {recent.length > 0 && (
            <div className="connections-recent">
              <div className="connections-recent-head">
                <span className="connections-recent-title">最近会话</span>
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
            <span className="connections-section-title">命令</span>
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
          <Tooltip title={conn.host === conn.host ? `双击连接 ${conn.host}` : undefined}>
            <AuthTags auth={conn.auth} />
          </Tooltip>
        </div>
        <div className="connections-row-sub">
          {conn.group ? `${conn.group} · ` : ''}
          {conn.host}:{conn.port} · {conn.username}
        </div>
      </div>
      <div className="connections-row-actions">
        <Button type="text" size="small" icon={<EditOutlined />} onClick={onEdit} aria-label="编辑" />
        <Popconfirm
          title="删除该连接？"
          description="连接配置删除后不可恢复。已保存的密钥数据会同步删除。"
          okText="删除"
          cancelText="取消"
          okButtonProps={{ danger: true }}
          open={confirming}
          onConfirm={onDelete}
          onOpenChange={(visible) => setConfirming(visible)}
          onCancel={() => setConfirming(false)}
        >
          <Button size="small" type="text" danger icon={<DeleteOutlined />} aria-label="删除" />
        </Popconfirm>
      </div>
    </div>
  )
}