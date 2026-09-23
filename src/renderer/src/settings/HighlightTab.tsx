import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Segmented,
  Select,
  Switch,
  Table,
  Tooltip
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { t } from '@shared/i18n'
import {
  DEFAULT_HIGHLIGHT_RULES,
  HIGHLIGHT_CATEGORIES,
  highlightModeOf,
  type HighlightCategory,
  type HighlightMode
} from '@shared/settings'
import type { HighlightRule } from '@shared/settings'
import { useResolvedTheme, useSettingsStore } from './store'
import { HighlightImportExport } from './HighlightImportExport'
import { HighlightProfiles } from './HighlightProfiles'
import { ruleNote } from './ruleLabel'
import { compileRules, previewSpans } from '../terminal/highlightEngine'
import {
  getHighlightStats,
  resetHighlightStats,
  subscribeHighlightStats
} from '../terminal/highlightStats'
import { applyThemeColors } from '../theme/highlightColors'
import './highlight.css'

const ORDERED_SORT: 'ascend' = 'ascend'

/** preset color swatches for the highlighting editor. */
const PRESET_COLORS = ['#3fb950', '#f85149', '#e3b341', '#58a6ff', '#d2a8ff', '#79c0ff', '#bc8cff', '#f2cc60']

/** Sample line for the editor preview — one line that exercises several presets. */
const SAMPLE_TEXT = 'SUCCESS 42 passed  85%  HTTP/1.1 404  exit code 1  deleted 3 files  120ms  rm -rf build'

/**
 * Longest slice of the test text that gets previewed. A 200 KB paste would
 * produce thousands of spans, and React re-renders every one of them per
 * keystroke — measured at ~12 ms of highlighting plus a janky paint.
 */
const PREVIEW_LIMIT = 2000

/** clone the builtin preset set to prevent reference pollution by mutations. */
const cloneDefaults = (): HighlightRule[] => JSON.parse(JSON.stringify(DEFAULT_HIGHLIGHT_RULES)) as HighlightRule[]

/** Compact duration for the stats column: µs below a millisecond, then ms. */
function formatMs(ms: number): string {
  if (ms <= 0) return '0'
  return ms < 1 ? `${Math.round(ms * 1000)}µs` : `${ms.toFixed(1)}ms`
}

/** Localised label for a rule's category, with a fallback for uncategorised rules. */
function categoryLabel(category: HighlightCategory | undefined): string {
  return t(`settings.highlight.category.${category ?? 'none'}`)
}

/** Sort rank for the grouped view: known categories in fixed order, none last. */
function categoryRank(rule: HighlightRule): number {
  if (rule.category === undefined) return HIGHLIGHT_CATEGORIES.length
  const index = HIGHLIGHT_CATEGORIES.indexOf(rule.category)
  return index < 0 ? HIGHLIGHT_CATEGORIES.length : index
}

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
  bands?: { min: number; fg: string }[]
  category?: HighlightCategory
  caseInsensitive: boolean
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
  const highlightMode = useSettingsStore((s) => highlightModeOf(s.settings.terminal.highlightMode))
  const groupByCategory = useSettingsStore((s) => s.settings.terminal.highlightGroupByCategory)
  const statsOn = useSettingsStore((s) => s.settings.terminal.highlightStats)
  const themeColorsOn = useSettingsStore((s) => s.settings.terminal.highlightThemeColors)
  const updateTerminal = useSettingsStore((s) => s.updateTerminal)
  const [editor, setEditor] = useState<EditorState>({ open: false })
  const [ioOpen, setIoOpen] = useState(false)

  const sorted = useMemo(() => {
    const rows = [...highlightRules].sort((a, b) => a.priority - b.priority)
    // Grouped view: cluster by category, keeping priority order inside a group
    // (Array.prototype.sort is stable, so the priority sort above survives).
    return groupByCategory ? rows.sort((a, b) => categoryRank(a) - categoryRank(b)) : rows
  }, [highlightRules, groupByCategory])

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

  /** Only present in the grouped view, where it also explains the row order. */
  const categoryColumn: ColumnsType<HighlightRule>[number] = {
    title: t('settings.highlight.category'),
    dataIndex: 'category',
    width: 96,
    align: 'center',
    filters: [
      ...HIGHLIGHT_CATEGORIES.map((category) => ({
        text: t(`settings.highlight.category.${category}`),
        value: category
      })),
      { text: t('settings.highlight.category.none'), value: 'none' }
    ],
    onFilter: (value, record) => (record.category ?? 'none') === value,
    render: (_category, record) => <span className="hl-cell-note">{categoryLabel(record.category)}</span>
  }

  const [statsTick, setStatsTick] = useState(0)
  useEffect(() => subscribeHighlightStats(() => setStatsTick((n) => n + 1)), [])
  const ruleStats = useMemo(() => getHighlightStats().rules, [statsTick])

  /** Only present while the stats switch is on. */
  const hitsColumn: ColumnsType<HighlightRule>[number] = {
    title: t('settings.highlight.statsHits'),
    key: 'hits',
    width: 76,
    align: 'center',
    sorter: (a, b) => (ruleStats.get(a.id)?.hits ?? 0) - (ruleStats.get(b.id)?.hits ?? 0),
    render: (_value, record) => (
      <span className="hl-cell-priority">{ruleStats.get(record.id)?.hits ?? 0}</span>
    )
  }
  const msColumn: ColumnsType<HighlightRule>[number] = {
    title: t('settings.highlight.statsMs'),
    key: 'ms',
    width: 88,
    align: 'center',
    sorter: (a, b) => (ruleStats.get(a.id)?.ms ?? 0) - (ruleStats.get(b.id)?.ms ?? 0),
    render: (_value, record) => (
      <span className="hl-cell-priority">{formatMs(ruleStats.get(record.id)?.ms ?? 0)}</span>
    )
  }

  const columns: ColumnsType<HighlightRule> = [
    ...(groupByCategory ? [categoryColumn] : []),
    ...(statsOn ? [hitsColumn, msColumn] : []),
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
      render: (_pattern: string, record) => <PatternCell rule={record} />
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
      width: 160,
      align: 'center',
      render: (color: HighlightRule['color'], record) =>
        record.bands && record.bands.length > 0 ? (
          <div className="hl-band-preview">
            {record.bands.map((band) => (
              <Tooltip key={band.min} title={`≥ ${band.min}`}>
                <span className="hl-preview-text" style={{ color: band.fg }}>
                  ≥{band.min}
                </span>
              </Tooltip>
            ))}
          </div>
        ) : (
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
      render: (_note: string | undefined, record) => {
        const note = ruleNote(record)
        return note ? <span className="hl-cell-note">{note}</span> : <span className="hl-cell-empty">—</span>
      }
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
        <Tooltip title={t('settings.highlight.modeDesc')}>
          <span className="hl-master">
            <span className="hl-editor-sub-label">{t('settings.highlight.mode')}</span>
            <Segmented
              size="small"
              value={highlightMode}
              onChange={(value) => void updateTerminal({ highlightMode: value as HighlightMode })}
              options={[
                { value: 'all', label: t('settings.highlight.modeAll') },
                { value: 'basic', label: t('settings.highlight.modeBasic') },
                { value: 'off', label: t('settings.highlight.modeOff') }
              ]}
            />
          </span>
        </Tooltip>
        <Tooltip title={t('settings.highlight.groupByCategory')}>
          <span className="hl-master">
            <Switch
              size="small"
              checked={groupByCategory}
              onChange={(checked) => void updateTerminal({ highlightGroupByCategory: checked })}
            />
            <span className="hl-editor-sub-label">{t('settings.highlight.groupByCategory')}</span>
          </span>
        </Tooltip>
        <Tooltip title={t('settings.highlight.statsHint')}>
          <span className="hl-master">
            <Switch
              size="small"
              checked={statsOn}
              onChange={(checked) => void updateTerminal({ highlightStats: checked })}
            />
            <span className="hl-editor-sub-label">{t('settings.highlight.stats')}</span>
          </span>
        </Tooltip>
        {statsOn && (
          <Button size="small" onClick={() => resetHighlightStats()}>
            {t('settings.highlight.statsReset')}
          </Button>
        )}
        <Tooltip title={t('settings.highlight.themeColorsHint')}>
          <span className="hl-master">
            <Switch
              size="small"
              checked={themeColorsOn}
              onChange={(checked) => void updateTerminal({ highlightThemeColors: checked })}
            />
            <span className="hl-editor-sub-label">{t('settings.highlight.themeColors')}</span>
          </span>
        </Tooltip>
        <Button onClick={() => setIoOpen(true)}>{t('settings.highlight.importExport')}</Button>
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
      <HighlightImportExport open={ioOpen} onClose={() => setIoOpen(false)} />
      <HighlightProfiles />
      <div className={highlightMode === 'off' ? 'hl-table hl-table-off' : 'hl-table'}>
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

function PatternCell({ rule }: { rule: HighlightRule }): React.JSX.Element {
  const { ok, message } = tryCompile(rule.pattern)
  return (
    <div className="hl-pattern-cell">
      {rule.caseInsensitive === true && (
        <Tooltip title={t('settings.highlight.caseInsensitive')}>
          <span className="hl-case-badge">Aa</span>
        </Tooltip>
      )}
      <Tooltip title={rule.pattern}>
        <span className={ok ? 'hl-pattern-text' : 'hl-pattern-text hl-pattern-bad'}>{rule.pattern}</span>
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
  const themeColors = useSettingsStore((s) => s.settings.terminal.highlightThemeColors)
  const theme = useResolvedTheme()

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
    caseInsensitive: false,
    note: undefined,
    enabled: true
  })
  const [saving, setSaving] = useState(false)
  const [showBg, setShowBg] = useState(false)
  const [testText, setTestText] = useState('')

  /**
   * Preview the draft rule *together with* the other rules: a span that some
   * earlier rule steals (`done`, claimed by the shell-keyword rule) then shows up
   * here rather than surprising the user in the terminal.
   */
  const previewRules = useMemo(() => {
    const draftRule: HighlightRule = {
      id: ruleId ?? 'draft',
      pattern: draft.pattern,
      enabled: true,
      priority: draft.priority,
      color: { fg: draft.fg, ...(showBg && draft.bg ? { bg: draft.bg } : {}) },
      ...(draft.bands && draft.bands.length > 0 ? { bands: draft.bands } : {}),
      ...(draft.caseInsensitive ? { caseInsensitive: true } : {})
    }
    const active = [...highlightRules.filter((rule) => rule.id !== ruleId), draftRule]
    // The preview has to show the colours the terminal will use, so the theme
    // mapping is applied here exactly as TerminalView applies it.
    return compileRules(themeColors ? applyThemeColors(active, theme) : active)
  }, [
    draft.pattern,
    draft.priority,
    draft.fg,
    draft.bg,
    draft.bands,
    draft.caseInsensitive,
    showBg,
    highlightRules,
    ruleId,
    themeColors,
    theme
  ])

  const preview = useMemo(
    () =>
      previewSpans(
        (testText.trim() === '' ? SAMPLE_TEXT : testText).slice(0, PREVIEW_LIMIT),
        previewRules
      ),
    [testText, previewRules]
  )

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
    const caseInsensitive = editing ? editing.caseInsensitive === true : false
    const bands = editing?.bands
    const category = editing?.category
    setDraft({ pattern, priority, fg, bg, bands, category, caseInsensitive, note, enabled })
    setShowBg(bg != null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const compile = tryCompile(draft.pattern)
  const valid = draft.pattern.trim() !== '' && compile.ok

  const patch = (partial: Partial<RuleDraft>): void => setDraft((prev) => ({ ...prev, ...partial }))

  const addBand = (): void => {
    const bands = draft.bands ?? []
    const top = bands[bands.length - 1]
    // the new row starts above the current top one, so it is usable as-is
    patch({ bands: [...bands, { min: top ? top.min + 20 : 0, fg: PRESET_COLORS[0] }] })
  }

  const updateBand = (index: number, partial: Partial<{ min: number; fg: string }>): void => {
    const bands = draft.bands
    if (!bands) return
    patch({ bands: bands.map((band, i) => (i === index ? { ...band, ...partial } : band)) })
  }

  const removeBand = (index: number): void => {
    const bands = draft.bands
    if (!bands) return
    const next = bands.filter((_, i) => i !== index)
    // dropping the last band switches the rule back to a single colour
    patch({ bands: next.length > 0 ? next : undefined })
  }

  const handleSave = async (): Promise<void> => {
    if (!valid) return
    setSaving(true)
    try {
      const color: HighlightRule['color'] = { fg: draft.fg, ...(showBg && draft.bg ? { bg: draft.bg } : {}) }
      const caseInsensitive = draft.caseInsensitive ? true : undefined
      const bands = draft.bands && draft.bands.length > 0 ? draft.bands : undefined
      if (isCreate) {
        const rule: HighlightRule = {
          id: crypto.randomUUID(),
          pattern: draft.pattern.trim(),
          priority: draft.priority,
          enabled: draft.enabled,
          color,
          bands,
          category: draft.category,
          caseInsensitive,
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
          bands,
          category: draft.category,
          caseInsensitive,
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
            <div className="hl-editor-inline">
              <Switch
                size="small"
                checked={draft.caseInsensitive}
                onChange={(c) => patch({ caseInsensitive: c })}
              />
              <span className="hl-editor-sub-label">{t('settings.highlight.caseInsensitive')}</span>
              <span className="hl-editor-hint">{t('settings.highlight.caseInsensitiveHint')}</span>
            </div>
          </div>
        </div>

        <div className="hl-editor-row">
          <span className="hl-editor-label">{t('settings.highlight.testText')}</span>
          <div className="hl-editor-control">
            <Input.TextArea
              value={testText}
              onChange={(e) => setTestText(e.target.value)}
              placeholder={SAMPLE_TEXT}
              autoSize={{ minRows: 1, maxRows: 3 }}
            />
            <div className="hl-preview-line">
              {preview.map((span, index) => (
                <span key={index} style={{ color: span.fg, background: span.bg }}>
                  {span.text}
                </span>
              ))}
            </div>
            <span className="hl-editor-hint">{t('settings.highlight.testHint')}</span>
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
          <span className="hl-editor-label">{t('settings.highlight.bands')}</span>
          <div className="hl-editor-control">
            <div className="hl-editor-inline">
              <Switch
                size="small"
                checked={draft.bands != null}
                onChange={(c) =>
                  patch({ bands: c ? (draft.bands ?? [{ min: 0, fg: draft.fg }]) : undefined })
                }
              />
              <span className="hl-editor-hint">{t('settings.highlight.bandsHint')}</span>
            </div>
            {draft.bands?.map((band, index) => (
              <div className="hl-editor-inline" key={index}>
                <span className="hl-editor-sub-label">{t('settings.highlight.bandMin')}</span>
                <InputNumber
                  size="small"
                  value={band.min}
                  onChange={(v) => updateBand(index, { min: typeof v === 'number' ? v : 0 })}
                  style={{ width: 88 }}
                />
                <ColorField value={band.fg} onChange={(v) => updateBand(index, { fg: v })} />
                <Button
                  size="small"
                  title={t('settings.highlight.removeBand')}
                  onClick={() => removeBand(index)}
                >
                  ×
                </Button>
              </div>
            ))}
            {draft.bands != null && (
              <div className="hl-editor-inline">
                <Button size="small" onClick={addBand}>
                  {t('settings.highlight.addBand')}
                </Button>
              </div>
            )}
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
          <span className="hl-editor-label">{t('settings.highlight.category')}</span>
          <Select
            size="small"
            allowClear
            style={{ width: 150 }}
            value={draft.category}
            placeholder={t('settings.highlight.category.none')}
            onChange={(value) => patch({ category: value ?? undefined })}
            options={HIGHLIGHT_CATEGORIES.map((category) => ({
              value: category,
              label: t(`settings.highlight.category.${category}`)
            }))}
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