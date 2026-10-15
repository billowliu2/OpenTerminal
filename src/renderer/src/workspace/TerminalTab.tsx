import { useEffect, useRef, useState } from 'react'
import { App, Button, Dropdown, Input, Modal, Popconfirm, Space } from 'antd'
import type { MenuProps } from 'antd'
import { CloudServerOutlined } from '@ant-design/icons'
import type { IDockviewPanelHeaderProps } from 'dockview-react'

import { useBroadcastStore } from './broadcastStore'
import { SshHostBadge } from './SshHostBadge'
import { useSettingsStore } from '@renderer/settings/store'
import { DEFAULT_LANGUAGE, t, tFor } from '@shared/i18n'
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
 * visually distinct from local terminals. Every user-initiated close button,
 * menu action and the tablist's Delete/Backspace accelerator goes through
 * `requestClose`, which may ask for confirmation first (see below). Whatever
 * the path, the workspace's `onDidRemovePanel` handles the pty kill, so
 * nothing leaks.
 */
export function TerminalTab({ api, params }: TerminalTabProps): React.JSX.Element {
  const panel = api.group // bound panel via the panel api
  type TabPanel = (typeof panel.panels)[number]
  const [title, setTitle] = useState<string | undefined>(api.title)
  const [pending, setPending] = useState<TabPanel[] | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const selfIndex = panel.panels.findIndex((p) => p.api === api)

  // dockview keeps the tab component in its own render slot — a re-render of
  // App/Workspace does not reach it — so the language has to be subscribed here
  // and passed to `tFor` explicitly; `t()` would read the module-level language
  // of whatever render last touched it.
  const language = useSettingsStore((s) => s.settings.system.language ?? DEFAULT_LANGUAGE)

  const isSsh = params?.sessionKind === 'ssh'
  const hostLabel: string | undefined = isSsh ? (params?.hostLabel || title) : undefined
  const tooltip = isSsh
    ? hostLabel && hostLabel !== title
      ? `${title} — ${hostLabel}`
      : (hostLabel || title)
    : tFor(language, 'workspace.tab.localTerminal')
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

  // `api.group` is read live rather than reusing the render-time `panel`:
  // dragging this tab into another group re-parents the DOM without re-mounting
  // the React component (dockview keeps the portal element and only swaps the
  // `.dv-tab` shell around it), so anything captured at render would still name
  // the group this tab has left.
  const selfPanel = (): TabPanel | undefined => api.group.panels.find((p) => p.api === api)

  // Confirmation has to happen *before* `api.close()`: dockview has no
  // vetoable close hook, and the workspace kills the session from
  // `onDidRemovePanel`, which is already too late to ask. Every user-initiated
  // close entry point funnels through here; programmatic closes (a dead
  // session, applying a layout template) call `api.close()` directly.
  //
  // Read the settings at call time: this runs from long-lived menu / keydown
  // handlers, so a value captured at render would go stale after a change.
  const needsConfirmFor = (targets: TabPanel[]): boolean => {
    const terminal = useSettingsStore.getState().settings.terminal
    return targets.some((p) =>
      (p.params as { sessionKind?: 'local' | 'ssh' } | undefined)?.sessionKind === 'ssh'
        ? terminal.confirmSshTabClose
        : terminal.confirmTabClose
    )
  }

  const requestClose = (targets: TabPanel[]): void => {
    if (targets.length === 0) return
    if (!needsConfirmFor(targets)) {
      for (const target of targets) target.api.close()
      return
    }
    setPending(targets)
  }

  const closePending = (): void => {
    if (!pending) return
    // Liveness filter: something else (a dead session, another tab's menu) may
    // have closed a target while the dialog was up. Asked of the panel itself —
    // its `group` follows it across groups, unlike a render-time snapshot.
    for (const target of pending) if (target.group.panels.includes(target)) target.api.close()
    setPending(null)
  }

  // dockview closes the focused tab on Delete/Backspace from a keydown listener
  // on the tab list, but only when the event target *is* the `.dv-tab` shell —
  // which is what has focus, and an ancestor of this component's root, so a
  // React handler on the root never sees the key. The listener therefore has to
  // be native, on the shell, in the capture phase (dockview listens during the
  // bubble phase). It is attached to the document rather than to the shell
  // itself because dragging a tab into another group re-parents this component's
  // DOM into a fresh shell *without* re-mounting or re-rendering it: a
  // shell-scoped listener would be stranded on the discarded element and
  // Delete/Backspace would silently stop working for that tab. Everything the
  // handler reads is resolved live (`api.group`, the settings), so the closure
  // from the first render stays correct.
  //
  // The event is only swallowed when a confirmation is actually required;
  // otherwise dockview's own handler runs as before, focus moved to the
  // neighbouring tab included, so "off" is indistinguishable from the old
  // behaviour.
  useEffect(() => {
    const doc = rootRef.current?.ownerDocument ?? document
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Delete' && event.key !== 'Backspace') return
      const shell = rootRef.current?.closest('.dv-tab')
      if (!shell || event.target !== shell) return
      // Only the real tab strip: the overflow dropdown renders a second
      // `.dv-tab`-classed wrapper around a copy of this component, and dockview's
      // own handler is scoped to the tab list, so match that scope instead of
      // closing a panel the platform would have left alone.
      if (!shell.closest('.dv-tabs-container')) return
      const self = selfPanel()
      if (!self || !needsConfirmFor([self])) return
      event.preventDefault()
      event.stopPropagation()
      requestClose([self])
    }
    doc.addEventListener('keydown', onKeyDown, true)
    return () => doc.removeEventListener('keydown', onKeyDown, true)
  }, [api])

  const menu: MenuProps = {
    items: [
      { key: 'close', label: tFor(language, 'common.close') },
      { key: 'closeOthers', label: tFor(language, 'workspace.tab.closeOthers'), disabled: panel.panels.length <= 1 },
      { key: 'closeRight', label: tFor(language, 'workspace.tab.closeRight'), disabled: selfIndex === -1 || selfIndex === panel.panels.length - 1 }
    ],
    onClick: ({ key }) => {
      const self = selfPanel()
      if (!self) {
        api.close()
        return
      }
      // `api.group.panels` is the live group array and `close()` splices it, so
      // the targets must be snapshotted first — otherwise every element that
      // shifts into the current index is skipped. Read through `api.group`
      // rather than a render-time copy in case the tab has since been dragged
      // into another group.
      const siblings = [...api.group.panels]
      if (key === 'close') {
        requestClose([self])
      } else if (key === 'closeOthers') {
        requestClose(siblings.filter((sibling) => sibling.api !== api))
      } else if (key === 'closeRight') {
        requestClose(siblings.slice(siblings.indexOf(self) + 1))
      }
    }
  }

  return (
    <>
      <Dropdown menu={menu} trigger={['contextMenu']}>
        <div
          ref={rootRef}
          className={`workspace-terminal-tab${isSsh ? ' workspace-terminal-tab-ssh' : ''}`}
          title={tooltip}
        >
          {isSsh && <CloudServerOutlined className="workspace-terminal-tab-icon" />}
          <span className="workspace-terminal-tab-title">{title}</span>
          {isSsh && hostLabel && <SshHostBadge label={hostLabel} language={language} />}
          {isBroadcastTarget && (
            <span
              className="workspace-terminal-tab-bcast"
              title={tFor(language, 'workspace.tab.broadcastTarget')}
              aria-label={tFor(language, 'workspace.tab.broadcastTarget')}
            >
              {tFor(language, 'workspace.tab.broadcastBadge')}
            </span>
          )}
          <button
            type="button"
            className="workspace-terminal-tab-close"
            aria-label={tFor(language, 'common.close')}
            onPointerDown={(event) => event.preventDefault()}
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              const self = selfPanel()
              if (self) requestClose([self])
            }}
          >
            <CloseGlyph />
          </button>
        </div>
      </Dropdown>
      <Modal
        open={pending !== null}
        title={tFor(language, 'workspace.tab.closeConfirmTitle')}
        okText={tFor(language, 'workspace.tab.closeConfirmOk')}
        okButtonProps={{ danger: true }}
        cancelText={tFor(language, 'common.cancel')}
        maskClosable={false}
        onOk={closePending}
        onCancel={() => setPending(null)}
      >
        {pending && pending.length === 1
          ? tFor(language, 'workspace.tab.closeConfirmOne', { title: pending[0].title ?? '' })
          : tFor(language, 'workspace.tab.closeConfirmMany', { count: pending?.length ?? 0 })}
      </Modal>
    </>
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
  const { message } = App.useApp()

  const handleOk = async (): Promise<void> => {
    const trimmed = name.trim()
    if (!trimmed) return
    setSaving(true)
    try {
      await onConfirm(trimmed)
      setName('')
      onCancel()
    } catch (error) {
      // The ok button calls this through `void`, so a rejection would surface
      // as an unhandled rejection instead of telling the user anything.
      console.error('[workspace] saving the layout template failed', error)
      message.error(t('common.saveFailed'))
      onCancel()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title={t('workspace.template.saveTitle')}
      open={open}
      onCancel={onCancel}
      onOk={handleOk}
      okText={t('common.save')}
      cancelText={t('common.cancel')}
      confirmLoading={saving}
      okButtonProps={{ disabled: !name.trim() }}
    >
      <Input
        placeholder={t('workspace.template.namePlaceholder')}
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
  const { message } = App.useApp()

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
    } catch (error) {
      // `onApply` reports a failed load itself; what reaches here is the
      // unexpected rejection (the layout read, an IPC failure), which the
      // `void` call site would otherwise drop as an unhandled rejection. The
      // workspace has already been put back into a usable state, so closing
      // the dialog is safe.
      console.error('[workspace] applying the layout template failed', meta.id, error)
      message.error(t('workspace.template.applyFailed'))
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
    <Modal title={t('workspace.template.applyTitle')} open={open} onCancel={onClose} footer={null} width={420}>
      {items.length === 0 ? (
        <div className="workspace-template-empty">{t('workspace.template.empty')}</div>
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
                  {t('workspace.template.apply')}
                </Button>
                <Popconfirm
                  title={t('workspace.template.deleteConfirm')}
                  okText={t('common.delete')}
                  cancelText={t('common.cancel')}
                  onConfirm={() => void handleDelete(meta)}
                >
                  <Button size="small" danger disabled={busyId === meta.id}>
                    {t('common.delete')}
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