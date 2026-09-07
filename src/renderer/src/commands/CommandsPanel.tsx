import { useCallback, useEffect, useState } from 'react'
import { Button, Modal, Popconfirm, Tabs } from 'antd'
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons'
import type { CommandItem } from '@shared/commands'
import { useWorkspaceModeStore } from '../workspace/workspaceModeStore'
import './commands.css'

export interface CommandsPanelProps {
  /** run a command in the currently active terminal/ssh panel */
  onRun: (cmd: string) => void
}

/** Short "time ago" for history rows (kept tiny — mirrors the connection patch). */

/** local date/time string for a row's sub-line */
export function formatClock(ts: number): string {
  return new Date(ts).toLocaleString()
}

/**
 * [M5] 「命令」 sidebar section: command history (listHistory/clearHistory) and
 * a small command library (saveLibraryItem/deleteLibraryItem). Clicking a row
 * runs the command via the parent workspace's `onRun`.
 */
export function CommandsPanel({ onRun }: CommandsPanelProps): React.JSX.Element {
  const [history, setHistory] = useState<CommandItem[]>([])
  const [library, setLibrary] = useState<CommandItem[]>([])
  const [loaded, setLoaded] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [note, setNote] = useState('')
  /** M6.1: current workspace group — the command panel's 发送目标 belongs to it. */
  const workspaceMode = useWorkspaceModeStore((s) => s.mode)

  const refresh = useCallback((): void => {
    void Promise.all([window.api.listHistory(), window.api.listLibrary()])
      .then(([h, l]) => {
        setHistory(h)
        setLibrary(l)
      })
      .catch(() => {
        setHistory([])
        setLibrary([])
      })
      .finally(() => setLoaded(true))
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const handleClearHistory = useCallback(async (): Promise<void> => {
    await window.api.clearHistory()
    refresh()
  }, [refresh])

  const handleDeleteLibrary = useCallback(
    async (id: string): Promise<void> => {
      await window.api.deleteLibraryItem(id)
      refresh()
    },
    [refresh]
  )

  const handleAdd = useCallback((): void => {
    setName('')
    setCommand('')
    setNote('')
    setAddOpen(true)
  }, [])

  const handleSave = useCallback(async (): Promise<void> => {
    const trimmed = command.trim()
    if (!trimmed) return
    await window.api.saveLibraryItem({
      id: window.crypto.randomUUID(),
      name: name.trim() || undefined,
      command: trimmed,
      note: note.trim() || undefined,
      createdAt: Date.now(),
      lastUsedAt: Date.now()
    })
    setAddOpen(false)
    refresh()
  }, [name, command, note, refresh])

  return (
    <div className="commands-panel">
      <div className={`commands-mode-badge commands-mode-badge--${workspaceMode}`}>
        <span className="commands-mode-badge-text">发送目标</span>
        <span className="commands-mode-badge-tag">{workspaceMode === 'ssh' ? 'SSH 服务器' : '终端'}</span>
      </div>
      <Tabs
        size="small"
        centered
        items={[
          {
            key: 'history',
            label: '历史',
            children: (
              <div className="commands-section">
                <div className="commands-section-head">
                  <span className="commands-section-title">历史命令</span>
                  {history.length > 0 && (
                    <Popconfirm
                      title="清空全部命令历史？"
                      okText="清空"
                      cancelText="取消"
                      okButtonProps={{ danger: true }}
                      onConfirm={() => void handleClearHistory()}
                    >
                      <Button type="text" size="small" danger className="commands-clear-btn">
                        清空
                      </Button>
                    </Popconfirm>
                  )}
                </div>
                {history.length === 0 ? (
                  <div className="commands-empty">{loaded ? '暂无历史命令' : '加载中…'}</div>
                ) : (
                  <ul className="commands-list">
                    {history.map((item) => (
                      <Row key={item.id} item={item} onRun={onRun} />
                    ))}
                  </ul>
                )}
              </div>
            )
          },
          {
            key: 'library',
            label: '命令库',
            children: (
              <div className="commands-section">
                <div className="commands-section-head">
                  <span className="commands-section-title">命令库</span>
                  <Button
                    type="text"
                    size="small"
                    icon={<PlusOutlined />}
                    onClick={handleAdd}
                    aria-label="新增命令"
                    title="新增命令"
                  />
                </div>
                {library.length === 0 ? (
                  <div className="commands-empty">{loaded ? '命令库为空' : '加载中…'}</div>
                ) : (
                  <ul className="commands-list">
                    {library.map((item) => (
                      <Row
                        key={item.id}
                        item={item}
                        onRun={onRun}
                        onDelete={() => void handleDeleteLibrary(item.id)}
                      />
                    ))}
                  </ul>
                )}
              </div>
            )
          }
        ]}
      />

      <Modal
        open={addOpen}
        title="新增命令"
        okText="保存"
        cancelText="取消"
        okButtonProps={{ disabled: command.trim().length === 0 }}
        onOk={() => void handleSave()}
        onCancel={() => setAddOpen(false)}
        className="commands-modal"
      >
        <div className="commands-form">
          <label className="commands-field">
            <span className="commands-field-label">名称</span>
            <input
              className="commands-input"
              type="text"
              value={name}
              placeholder="(可选)"
              spellCheck={false}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="commands-field">
            <span className="commands-field-label">命令</span>
            <input
              className="commands-input"
              type="text"
              value={command}
              placeholder="如 ls -la"
              spellCheck={false}
              autoFocus
              onChange={(e) => setCommand(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter' && command.trim()) void handleSave()
              }}
            />
          </label>
          <label className="commands-field">
            <span className="commands-field-label">备注</span>
            <input
              className="commands-input"
              type="text"
              value={note}
              placeholder="(可选)"
              spellCheck={false}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
        </div>
      </Modal>
    </div>
  )
}

function Row({
  item,
  onRun,
  onDelete
}: {
  item: CommandItem
  onRun: (cmd: string) => void
  onDelete?: () => void
}): React.JSX.Element {
  return (
    <li className="commands-row" onClick={() => onRun(item.command)} title={item.command}>
      <div className="commands-row-main" title={item.note}>
        <div className="commands-row-name">{item.name ?? item.command}</div>
        <div className="commands-row-sub">
          {item.name ? item.command : ''}
          {item.name ? ' · ' : ''}
          {formatClock(item.createdAt)}
        </div>
      </div>
      {item.name && onDelete && (
        <Popconfirm
          title="删除该命令？"
          okText="删除"
          cancelText="取消"
          okButtonProps={{ danger: true }}
          onConfirm={onDelete}
        >
          <Button
            type="text"
            size="small"
            danger
            icon={<DeleteOutlined />}
            className="commands-row-del"
            aria-label="删除命令"
          />
        </Popconfirm>
      )}
    </li>
  )
}