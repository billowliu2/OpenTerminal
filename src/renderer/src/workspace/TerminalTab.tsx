import { useEffect, useState } from 'react'
import { Button, Dropdown, Input, Modal, Popconfirm, Space } from 'antd'
import type { MenuProps } from 'antd'
import { CloudServerOutlined } from '@ant-design/icons'
import type { IDockviewPanelHeaderProps } from 'dockview-react'

import { useBroadcastStore } from './broadcastStore'
import { SshHostBadge } from './SshHostBadge'
import type { LayoutMeta } from '@shared/ipc'

export type TerminalTabProps = IDockviewPanelHeaderProps<{
  sessionId?: string
  sessionKind?: 'local' | 'ssh'
  hostLabel?: string
}>

/**
 * Custom tab renderer for terminal panels: default dockview tab look (title +
 * close glyph) with an antd context menu:
 *   关闭 / 关闭其他 / 关闭右侧
 *
 * SSH sessions get a 🖥 server icon and a green left-border accent so they're
 * visually distinct from local terminals. All menu actions close panels
 * directly through `api.close()`. The workspace's `onDidRemovePanel` handles
 * the pty kill, so nothing leaks.
 */
export function TerminalTab({ api, params }: TerminalTabProps): React.JSX.Element {
  const panel = api.group // bound panel via the panel api
  const [title, setTitle] = useState<string | undefined>(api.title)
  const selfIndex = panel.panels.findIndex((p) => p.api === api)

  const isSsh = params?.sessionKind === 'ssh'
  const hostLabel: string | undefined = isSsh ? (params?.hostLabel || title) : undefined
  const tooltip = isSsh
    ? hostLabel && hostLabel !== title
      ? `${title} — ${hostLabel}`
      : (hostLabel || title)
    : '本地终端'
  // M6 broadcast: show a badge on tabs that are current broadcast targets.
  const isBroadcastTarget = useBroadcastStore((state) => state.targets.has(params?.sessionId ?? ''))

  // Keep the tab title live (dockview re-renders tab components only on
  // params changes; title updates arrive through this event).
  useEffect(() => {
    const disposable = api.onDidTitleChange((event) => {
      setTitle(event.title)
    })
    return () => disposable.dispose()
  }, [api])

  const closePanel = (target: typeof panel.panels[number]): void => {
    target.api.close()
  }

  const menu: MenuProps = {
    items: [
      { key: 'close', label: '关闭' },
      { key: 'closeOthers', label: '关闭其他', disabled: panel.panels.length <= 1 },
      { key: 'closeRight', label: '关闭右侧', disabled: selfIndex === -1 || selfIndex === panel.panels.length - 1 }
    ],
    onClick: ({ key }) => {
      if (key === 'close') {
        api.close()
      } else if (key === 'closeOthers') {
        for (const sibling of panel.panels) {
          if (sibling.api !== api) closePanel(sibling)
        }
      } else if (key === 'closeRight') {
        for (let i = selfIndex + 1; i < panel.panels.length; i++) {
          closePanel(panel.panels[i])
        }
      }
    }
  }

  return (
    <Dropdown menu={menu} trigger={['contextMenu']}>
      <div
        className={`workspace-terminal-tab${isSsh ? ' workspace-terminal-tab-ssh' : ''}`}
        title={tooltip}
      >
        {isSsh && <CloudServerOutlined className="workspace-terminal-tab-icon" />}
        <span className="workspace-terminal-tab-title">{title}</span>
        {isSsh && hostLabel && <SshHostBadge label={hostLabel} />}
        {isBroadcastTarget && (
          <span
            className="workspace-terminal-tab-bcast"
            title="广播目标"
            aria-label="广播目标"
          >
            播
          </span>
        )}
        <button
          type="button"
          className="workspace-terminal-tab-close"
          aria-label="关闭"
          onPointerDown={(event) => event.preventDefault()}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            api.close()
          }}
        >
          <CloseGlyph />
        </button>
      </div>
    </Dropdown>
  )
}

function CloseGlyph(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true">
      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

export function SaveTemplateModal({
  open,
  onCancel,
  onConfirm
}: {
  open: boolean
  onCancel: () => void
  onConfirm: (name: string) => Promise<void>
}): React.JSX.Element {
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)

  const handleOk = async (): Promise<void> => {
    const trimmed = name.trim()
    if (!trimmed) return
    setSaving(true)
    try {
      await onConfirm(trimmed)
      setName('')
      onCancel()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title="保存布局模板"
      open={open}
      onCancel={onCancel}
      onOk={handleOk}
      okText="保存"
      cancelText="取消"
      confirmLoading={saving}
      okButtonProps={{ disabled: !name.trim() }}
    >
      <Input
        placeholder="模板名称"
        value={name}
        autoFocus
        onChange={(event) => setName(event.target.value)}
        onPressEnter={handleOk}
      />
    </Modal>
  )
}

export function ApplyTemplateModal({
  open,
  onClose,
  onApply,
  onDelete,
  list
}: {
  open: boolean
  onClose: () => void
  onApply: (meta: LayoutMeta) => Promise<void>
  onDelete: (meta: LayoutMeta) => Promise<void>
  list: () => Promise<LayoutMeta[]>
}): React.JSX.Element {
  const [items, setItems] = useState<LayoutMeta[]>([])
  const [busyId, setBusyId] = useState<string | null>(null)

  const refresh = async (): Promise<void> => {
    setItems(await list())
  }

  useEffect(() => {
    if (open) void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const handleApply = async (meta: LayoutMeta): Promise<void> => {
    setBusyId(meta.id)
    try {
      await onApply(meta)
      onClose()
    } finally {
      setBusyId(null)
    }
  }

  const handleDelete = async (meta: LayoutMeta): Promise<void> => {
    setBusyId(meta.id)
    try {
      await onDelete(meta)
      await refresh()
    } finally {
      setBusyId(null)
    }
  }

  return (
    <Modal title="应用布局模板" open={open} onCancel={onClose} footer={null} width={420}>
      {items.length === 0 ? (
        <div className="workspace-template-empty">暂无已保存的模板</div>
      ) : (
        <ul className="workspace-template-list">
          {items.map((meta) => (
            <li key={meta.id} className="workspace-template-item">
              <div className="workspace-template-meta">
                <div className="workspace-template-name">{meta.name}</div>
                <div className="workspace-template-time">
                  {new Date(meta.createdAt).toLocaleString()}
                </div>
              </div>
              <Space size={4}>
                <Button
                  size="small"
                  loading={busyId === meta.id}
                  onClick={() => void handleApply(meta)}
                >
                  应用
                </Button>
                <Popconfirm
                  title="删除该模板？"
                  okText="删除"
                  cancelText="取消"
                  onConfirm={() => void handleDelete(meta)}
                >
                  <Button size="small" danger disabled={busyId === meta.id}>
                    删除
                  </Button>
                </Popconfirm>
              </Space>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  )
}