import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Switch,
  Table,
  Tooltip
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { t } from '@shared/i18n'
import { DEFAULT_HIGHLIGHT_RULES } from '@shared/settings'
import type { HighlightRule } from '@shared/settings'
import { useSettingsStore } from './store'
import './highlight.css'

const ORDERED_SORT: 'ascend' = 'ascend'

/** preset color swatches for the highlighting editor. */
const PRESET_COLORS = ['#3fb950', '#f85149', '#e3b341', '#58a6ff', '#d2a8ff', '#79c0ff', '#bc8cff', '#f2cc60']

/** clone the builtin preset set to prevent reference pollution by mutations. */
const cloneDefaults = (): HighlightRule[] => JSON.parse(JSON.stringify(DEFAULT_HIGHLIGHT_RULES)) as HighlightRule[]

function tryCompile(pattern: string): { ok: boolean; message?: string } {
  if (pattern.trim() === '') return { ok: true }
  try {
    // eslint-disable-next-line no-new
    new RegExp(pattern)
    return { ok: true }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : t('settings.highlight.invalidRegex') }
  }
}

interface RuleDraft {
  pattern: string
  priority: number
  fg: string
  bg?: string
  note?: string
  enabled: boolean
}

interface EditorState {
  open: boolean
  /** editing an existing rule → its id; create mode → undefined */
  id?: string
}

export function HighlightTab(): React.JSX.Element {
  const highlightRules = useSettingsStore((s) => s.settings.highlightRules)
  const setHighlightRules = useSettingsStore((s) => s.setHighlightRules)
  const [editor, setEditor] = useState<EditorState>({ open: false })

  const sorted = useMemo(
    () => [...highlightRules].sort((a, b) => a.priority - b.priority),
    [highlightRules]
  )

  const openCreate = (): void => setEditor({ open: true, id: undefined })
  const openEdit = (target: HighlightRule): void => setEditor({ open: true, id: target.id })
  const closeEditor = (): void => setEditor((prev) => (prev.open ? { ...prev, open: false } : prev))

  const replaceRule = async (updated: HighlightRule): Promise<void> => {
    const next = highlightRules.map((r) => (r.id === updated.id ? updated : r))
    await setHighlightRules(next)
  }

  const toggleRule = async (target: HighlightRule, checked: boolean): Promise<void> => {
    await replaceRule({ ...target, enabled: checked })
  }

  const handleDelete = async (id: string): Promise<void> => {
    await setHighlightRules(highlightRules.filter((r) => r.id !== id))
  }

  const handleReset = async (): Promise<void> => {
    await setHighlightRules(cloneDefaults())
  }

  const columns: ColumnsType<HighlightRule> = [
    {
      title: t('settings.highlight.enabled'),
      dataIndex: 'enabled',
      width: 64,
      align: 'center',
      render: (enabled: boolean, record) => (
        <Switch size="small" checked={enabled} onChange={(c) => void toggleRule(record, c)} />
      )
    },
    {
      title: t('settings.highlight.pattern'),
      dataIndex: 'pattern',
      ellipsis: true,
      render: (pattern: string) => <PatternCell pattern={pattern} />
    },
    {
      title: t('settings.highlight.priority'),
      dataIndex: 'priority',
      width: 76,
      align: 'center',
      sorter: (a, b) => a.priority - b.priority,
      defaultSortOrder: ORDERED_SORT,
      render: (priority: number) => <span className="hl-cell-priority">{priority}</span>
    },
    {
      title: t('settings.preview'),
      dataIndex: 'color',
      width: 120,
      align: 'center',
      render: (color: HighlightRule['color']) => (
        <span
          className="hl-preview-text"
          style={{
            color: color.fg,
            ...(color.bg ? { background: color.bg, borderRadius: 3, padding: '0 4px' } : {})
          }}
        >
          Highlight
        </span>
      )
    },
    {
      title: t('settings.highlight.note'),
      dataIndex: 'note',
      ellipsis: true,
      render: (note: string | undefined) =>
        note ? <span className="hl-cell-note">{note}</span> : <span className="hl-cell-empty">—</span>
    },
    {
      title: t('settings.highlight.actions'),
      key: 'action',
      width: 120,
      align: 'center',
      render: (_, record) => (
        <div className="hl-actions">
          <Button size="small" onClick={() => openEdit(record)}>
            {t('common.edit')}
          </Button>
          <Popconfirm
            title={t('settings.highlight.deleteTitle')}
            description={t('settings.deleteConfirmDesc')}
            okText={t('common.delete')}
            cancelText={t('common.cancel')}
            okButtonProps={{ danger: true }}
            onConfirm={() => void handleDelete(record.id)}
          >
            <Button size="small" danger>
              {t('common.delete')}
            </Button>
          </Popconfirm>
        </div>
      )
    }
  ]

  return (
    <div className="hl-tab">
      <Alert
        type="info"
        showIcon
        closable
        message={t('settings.highlight.alert')}
      />
      <div className="hl-toolbar">
        <Popconfirm
          title={t('settings.highlight.resetTitle')}
          description={t('settings.highlight.resetDesc')}
          okText={t('settings.highlight.resetOk')}
          cancelText={t('common.cancel')}
          onConfirm={() => void handleReset()}
        >
          <Button>{t('common.reset')}</Button>
        </Popconfirm>
        <Button type="primary" onClick={openCreate}>
          {t('settings.highlight.addRule')}
        </Button>
      </div>
      <div className="hl-table">
        <Table
          size="small"
          rowKey="id"
          columns={columns}
          dataSource={sorted}
          pagination={false}
          locale={{ emptyText: t('settings.highlight.empty') }}
        />
      </div>
      <HighlightEditor
        open={editor.open}
        onClose={closeEditor}
        ruleId={editor.id}
      />
    </div>
  )
}

function PatternCell({ pattern }: { pattern: string }): React.JSX.Element {
  const { ok, message } = tryCompile(pattern)
  return (
    <div className="hl-pattern-cell">
      <Tooltip title={pattern}>
        <span className={ok ? 'hl-pattern-text' : 'hl-pattern-text hl-pattern-bad'}>{pattern}</span>
      </Tooltip>
      {!ok && (
        <Tooltip title={message}>
          <span className="hl-warn-icon">⚠</span>
        </Tooltip>
      )}
    </div>
  )
}

/**
 * Modal for creating / editing a single highlight rule. Mirrors the structure
 * of ThemeEditor: local draft state, initialized on open, saved through the store.
 */
function HighlightEditor({
  open,
  onClose,
  ruleId
}: {
  open: boolean
  onClose: () => void
  ruleId?: string
}): React.JSX.Element {
  const highlightRules = useSettingsStore((s) => s.settings.highlightRules)
  const setHighlightRules = useSettingsStore((s) => s.setHighlightRules)

  const isCreate = ruleId === undefined
  const editing = useMemo(
    () => (ruleId ? highlightRules.find((r) => r.id === ruleId) : undefined),
    [highlightRules, ruleId]
  )

  const [draft, setDraft] = useState<RuleDraft>({
    pattern: '',
    priority: 1,
    fg: '#3fb950',
    bg: undefined,
    note: undefined,
    enabled: true
  })
  const [saving, setSaving] = useState(false)
  const [showBg, setShowBg] = useState(false)

  // (re)initialize the form each time the modal opens
  useEffect(() => {
    if (!open) return
    if (!isCreate && editing === undefined) {
      onClose()
      return
    }
    const pattern = editing ? editing.pattern : ''
    const priority = editing ? editing.priority : 1
    const fg = editing ? editing.color.fg : PRESET_COLORS[0]
    const bg = editing ? editing.color.bg : undefined
    const note = editing ? editing.note : undefined
    const enabled = editing ? editing.enabled : true
    setDraft({ pattern, priority, fg, bg, note, enabled })
    setShowBg(bg != null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const compile = tryCompile(draft.pattern)
  const valid = draft.pattern.trim() !== '' && compile.ok

  const patch = (partial: Partial<RuleDraft>): void => setDraft((prev) => ({ ...prev, ...partial }))

  const handleSave = async (): Promise<void> => {
    if (!valid) return
    setSaving(true)
    try {
      const color: HighlightRule['color'] = { fg: draft.fg, ...(showBg && draft.bg ? { bg: draft.bg } : {}) }
      if (isCreate) {
        const rule: HighlightRule = {
          id: crypto.randomUUID(),
          pattern: draft.pattern.trim(),
          priority: draft.priority,
          enabled: draft.enabled,
          color,
          note: draft.note?.trim() ? draft.note.trim() : undefined
        }
        await setHighlightRules([...highlightRules, rule])
      } else if (editing !== undefined) {
        const rule: HighlightRule = {
          ...editing,
          pattern: draft.pattern.trim(),
          priority: draft.priority,
          enabled: draft.enabled,
          color,
          note: draft.note?.trim() ? draft.note.trim() : undefined
        }
        await setHighlightRules(highlightRules.map((r) => (r.id === rule.id ? rule : r)))
      }
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onCancel={onClose}
      onOk={() => void handleSave()}
      okText={t('common.save')}
      cancelText={t('common.cancel')}
      confirmLoading={saving}
      destroyOnHidden
      width={560}
      title={isCreate ? t('settings.highlight.createTitle') : t('settings.highlight.editTitle')}
      okButtonProps={{ disabled: !valid }}
    >
      <div className="hl-editor">
        <div className="hl-editor-row">
          <span className="hl-editor-label">{t('settings.highlight.pattern')}</span>
          <div className="hl-editor-control">
            <Input.TextArea
              value={draft.pattern}
              onChange={(e) => patch({ pattern: e.target.value })}
              placeholder={t('settings.highlight.patternPlaceholder')}
              autoSize={{ minRows: 1, maxRows: 4 }}
              className={compile.ok ? undefined : 'hl-editor-input-bad'}
            />
            {!compile.ok && compile.message != null && (
              <div className="hl-editor-error">{compile.message}</div>
            )}
          </div>
        </div>

        <div className="hl-editor-row">
          <span className="hl-editor-label">{t('settings.highlight.priority')}</span>
          <InputNumber
            min={1}
            max={100}
            value={draft.priority}
            onChange={(v) => {
              if (v !== null) patch({ priority: v })
            }}
          />
          <span className="hl-editor-hint">{t('settings.highlight.priorityHint')}</span>
        </div>

        <div className="hl-editor-row">
          <span className="hl-editor-label">{t('settings.highlight.color')}</span>
          <div className="hl-editor-control">
            <ColorField
              label={t('settings.color.foreground')}
              value={draft.fg}
              onChange={(v) => patch({ fg: v })}
            />
            <div className="hl-editor-inline">
              <span className="hl-editor-sub-label">{t('settings.color.background')}</span>
              {showBg ? (
                <>
                  <ColorField
                    value={draft.bg ?? PRESET_COLORS[0]}
                    onChange={(v) => patch({ bg: v })}
                  />
                  <Button size="small" onClick={() => patch({ bg: undefined })}>
                    {t('settings.highlight.clearBg')}
                  </Button>
                </>
              ) : (
                <Button size="small" onClick={() => setShowBg(true)}>
                  {t('settings.highlight.addBg')}
                </Button>
              )}
            </div>
          </div>
        </div>

        <div className="hl-editor-row">
          <span className="hl-editor-label">{t('settings.highlight.palette')}</span>
          <div className="hl-palette">
            {showBg && <span className="hl-palette-tag">{t('settings.color.background')}</span>}
            {PRESET_COLORS.map((c) => (
              <PaletteSwatch
                key={c}
                color={c}
                selected={showBg ? draft.bg : draft.fg}
                onClick={(v) => (showBg ? patch({ bg: v }) : patch({ fg: v }))}
              />
            ))}
          </div>
        </div>

        <div className="hl-editor-row">
          <span className="hl-editor-label">{t('settings.highlight.note')}</span>
          <Input
            value={draft.note ?? ''}
            onChange={(e) => patch({ note: e.target.value })}
            placeholder={t('settings.highlight.notePlaceholder')}
            maxLength={60}
          />
        </div>

        <div className="hl-editor-row">
          <span className="hl-editor-label">{t('settings.highlight.enabled')}</span>
          <Switch checked={draft.enabled} onChange={(c) => patch({ enabled: c })} />
        </div>
      </div>
    </Modal>
  )
}

function ColorField({
  label,
  value,
  onChange
}: {
  label?: string
  value: string
  onChange: (value: string) => void
}): React.JSX.Element {
  return (
    <div className="hl-color-field">
      {label != null && <span className="hl-editor-sub-label">{label}</span>}
      <input
        type="color"
        className="hl-color-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  )
}

function PaletteSwatch({
  color,
  selected,
  onClick
}: {
  color: string
  selected?: string
  onClick: (value: string) => void
}): React.JSX.Element {
  const isSel = color === selected
  return (
    <span
      className={isSel ? 'hl-swatch hl-swatch-selected' : 'hl-swatch'}
      style={{ background: color }}
      title={color}
      onClick={() => onClick(color)}
    />
  )
}