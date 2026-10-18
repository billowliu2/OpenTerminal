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
  Tag,
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
import type { HighlightRule, LinkRule } from '@shared/settings'
import {
  EMPTY_LINK_RULES,
  LINK_NOTE_MAX,
  LINK_PATTERN_MAX,
  LINK_TEMPLATE_MAX,
  isSafeLinkTemplate,
  linkRuleRunState
} from '@shared/linkRules'
import { PROBE_VERSION } from '@shared/redosProbes'
import { highlightFlags, proofMatches, type RuleRunState } from '@shared/ruleValidation'
import { useResolvedTheme, useSettingsStore } from './store'
import { HighlightImportExport } from './HighlightImportExport'
import { HighlightProfiles } from './HighlightProfiles'
import { ruleNote } from './ruleLabel'
import { useRuleProbe } from './ruleProbe'
import {
  MAX_PATTERN_LEN,
  compileRules,
  highlightRuleRunState,
  isReDoSProne,
  previewSpans
} from '../terminal/highlightEngine'
import {
  getHighlightStats,
  resetHighlightStats,
  subscribeHighlightStats
} from '../terminal/highlightStats'
import { applyThemeColors } from '../theme/highlightColors'
import './highlight.css'

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

/** Tag colour per run state. `pending` is a warning rather than an error: the
 *  rule is kept and will be re-checked, it just does not run yet. */
const STATE_COLOR: Record<RuleRunState, string> = {
  builtin: 'default',
  passed: 'success',
  pending: 'warning',
  quarantined: 'error'
}

/**
 * The proof state of one stored rule. Deliberately worded as "passed the
 * CURRENT probes": the corpus is a fixed set of hostile shapes, so a pass is
 * evidence about those shapes on this build, never a claim of safety.
 */
function RuleStateTag({ state }: { state: RuleRunState }): React.JSX.Element {
  return (
    <Tooltip title={t(`settings.highlight.state.${state}Hint`)}>
      <Tag color={STATE_COLOR[state]} className="hl-state-tag">
        {t(`settings.highlight.state.${state}`)}
      </Tag>
    </Tooltip>
  )
}

/** Sort rank for the grouped view: known categories in fixed order, none last. */
function categoryRank(rule: HighlightRule): number {
  if (rule.category === undefined) return HIGHLIGHT_CATEGORIES.length
  const index = HIGHLIGHT_CATEGORIES.indexOf(rule.category)
  return index < 0 ? HIGHLIGHT_CATEGORIES.length : index
}

function tryCompile(pattern: string): { ok: boolean; message?: string; slow?: boolean } {
  if (pattern.trim() === '') return { ok: true }
  try {
    // eslint-disable-next-line no-new
    new RegExp(pattern)
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : t('settings.highlight.invalidRegex') }
  }
  // Compiling is not the same as being safe to run: `(a+)+$` compiles instantly
  // and then takes ~8s on 30 characters. This shape check is an ADVISORY for the
  // editor only — it has measured misses (`[(](a+)+$`, `(?:a|a)+`) and false
  // positives, so it can never gate execution. The real gate is the probe
  // verdict (`useRuleProbe`), which the draft has to pass before it is previewed
  // or saved into a running rule set.
  return { ok: true, slow: isReDoSProne(pattern) }
}


interface RuleDraft {
  pattern: string
  priority: number
  fg: string
  bg?: string
  bands?: { min: number; fg: string }[]
  category?: HighlightCategory
  caseInsensitive: boolean
  /** anchor `^`/`$` per line (regex 'm' flag) */
  lineAnchor: boolean
  /** raise an in-app alert when this rule paints a span */
  notify: boolean
  note?: string
  enabled: boolean
  basic: boolean
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
  const ruleValidation = useSettingsStore((s) => s.ruleValidation)
  const updateTerminal = useSettingsStore((s) => s.updateTerminal)
  const [editor, setEditor] = useState<EditorState>({ open: false })
  const [ioOpen, setIoOpen] = useState(false)

  const sorted = useMemo(() => {
    const rows = [...highlightRules].sort((a, b) => a.priority - b.priority)
    // Grouped view: cluster by category, keeping priority order inside a group
    // (Array.prototype.sort is stable, so the priority sort above survives).
    // The table must not carry a defaultSortOrder — antd would re-sort the
    // dataSource globally and undo this clustering.
    return groupByCategory ? rows.sort((a, b) => categoryRank(a) - categoryRank(b)) : rows
  }, [highlightRules, groupByCategory])

  const openCreate = (): void => setEditor({ open: true, id: undefined })
  const openEdit = (target: HighlightRule): void => setEditor({ open: true, id: target.id })
  const closeEditor = (): void => setEditor((prev) => (prev.open ? { ...prev, open: false } : prev))

  const replaceRule = async (updated: HighlightRule): Promise<void> => {
    // read at call time: the render-scoped array goes stale inside a React
    // batch, and two writes in one batch would silently drop the first
    const current = useSettingsStore.getState().settings.highlightRules
    const next = current.map((r) => (r.id === updated.id ? updated : r))
    await setHighlightRules(next)
  }

  const toggleRule = async (target: HighlightRule, checked: boolean): Promise<void> => {
    await replaceRule({ ...target, enabled: checked })
  }

  const handleDelete = async (id: string): Promise<void> => {
    const current = useSettingsStore.getState().settings.highlightRules
    await setHighlightRules(current.filter((r) => r.id !== id))
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
  // Already merged across every open pane (hits and ms summed per rule), so the
  // hits/time columns and the reset button need no per-pane notion: one row per
  // rule, and a reset zeroes all panes at once.
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
      title: t('settings.highlight.validation'),
      key: 'validation',
      width: 132,
      align: 'center',
      render: (_value, record) => <RuleStateTag state={highlightRuleRunState(record)} />
    },
    {
      title: t('settings.highlight.priority'),
      dataIndex: 'priority',
      width: 76,
      align: 'center',
      sorter: (a, b) => a.priority - b.priority,
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
            {record.bands.map((band, index) => (
              <Tooltip key={index} title={`≥ ${band.min}`}>
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
            {t('settings.highlight.sampleText')}
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
      {/* Feature-level state, not a per-rule verdict: without a worker nothing
          custom can run at all, and the page has to say so rather than leaving
          the user staring at rows that silently do nothing. */}
      {!ruleValidation.workerAvailable && (
        <Alert
          type="error"
          showIcon
          message={t('settings.highlight.validatorUnavailable')}
          className="hl-probe-alert"
        />
      )}
      {ruleValidation.workerAvailable && ruleValidation.quarantined > 0 && (
        <Alert
          type="warning"
          showIcon
          message={t('settings.highlight.quarantinedWarning', { n: ruleValidation.quarantined })}
          className="hl-probe-alert"
        />
      )}
      <div className="hl-toolbar">
        <div className="hl-toolbar-controls">
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
        </div>
        <div className="hl-toolbar-actions">
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
      <ClickableLinkRules />
    </div>
  )
}

/**
 * User-defined clickable link rules ("pattern match → URL template → click").
 *
 * It lives at the bottom of the highlight tab because it is the same mental
 * model as a highlight rule — a regex over terminal output — with a different
 * payoff: instead of colouring the span, it turns the span into a link. The
 * provider reads the rules through a ref, so saving here takes effect on the
 * next hover without touching a single open session.
 */
function ClickableLinkRules(): React.JSX.Element {
  const linkRules = useSettingsStore((s) => s.settings.linkRules ?? EMPTY_LINK_RULES)
  const setLinkRules = useSettingsStore((s) => s.setLinkRules)

  /** null = dialog closed; '' = creating; otherwise the rule being edited. */
  const [editingId, setEditingId] = useState<string | null>(null)
  const [pattern, setPattern] = useState('')
  const [template, setTemplate] = useState('')
  const [note, setNote] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [saving, setSaving] = useState(false)

  const editing = linkRules.find((rule) => rule.id === editingId)

  // seed the dialog each time it opens
  useEffect(() => {
    if (editingId === null) return
    setPattern(editing?.pattern ?? '')
    setTemplate(editing?.template ?? '')
    setNote(editing?.note ?? '')
    setEnabled(editing?.enabled !== false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingId])

  const compile = tryCompile(pattern)
  const templateOk = template.trim() === '' || isSafeLinkTemplate(template)
  const valid =
    pattern.trim() !== '' && compile.ok && template.trim() !== '' && templateOk

  /**
   * The draft's probe verdict. Link rules have no built-in whitelist, so a
   * pattern only runs once the main process has measured it — which is why the
   * dialog shows the state instead of silently saving something inert.
   */
  const probe = useRuleProbe({
    kind: 'link',
    pattern: pattern.trim(),
    enabled: editingId !== null && valid
  })
  const probeState: RuleRunState =
    probe.state === 'passed' ? 'passed' : probe.state === 'quarantined' ? 'quarantined' : 'pending'

  const patchRule = async (target: LinkRule, partial: Partial<LinkRule>): Promise<void> => {
    // read at call time: the render-scoped array goes stale inside a React batch
    const current = useSettingsStore.getState().settings.linkRules ?? EMPTY_LINK_RULES
    await setLinkRules(current.map((rule) => (rule.id === target.id ? { ...rule, ...partial } : rule)))
  }

  const handleSave = async (): Promise<void> => {
    if (!valid) return
    setSaving(true)
    try {
      const trimmedNote = note.trim()
      const current = useSettingsStore.getState().settings.linkRules ?? EMPTY_LINK_RULES
      if (editing !== undefined) {
        // The proof travels with the pattern it was obtained for: editing the
        // pattern drops it (the row goes back to `pending` until the main
        // process re-proves it), an unchanged one keeps it.
        const next: LinkRule = {
          ...editing,
          pattern: pattern.trim(),
          template: template.trim(),
          // explicit override: unchecking must clear an `enabled: true` the
          // edited rule may already carry
          enabled,
          ...(trimmedNote ? { note: trimmedNote } : { note: undefined }),
          ...(editing.pattern === pattern.trim() ? {} : { validation: undefined })
        }
        await setLinkRules(current.map((rule) => (rule.id === next.id ? next : rule)))
      } else {
        const fresh: LinkRule = {
          id: crypto.randomUUID(),
          pattern: pattern.trim(),
          template: template.trim(),
          enabled,
          ...(trimmedNote ? { note: trimmedNote } : {})
        }
        await setLinkRules([...current, fresh])
      }
      setEditingId(null)
    } finally {
      setSaving(false)
    }
  }

  const columns: ColumnsType<LinkRule> = [
    {
      title: t('settings.highlight.linkEnabled'),
      dataIndex: 'enabled',
      width: 64,
      align: 'center',
      render: (value: boolean | undefined, record) => (
        <Switch
          size="small"
          checked={value !== false}
          onChange={(checked) => void patchRule(record, { enabled: checked })}
        />
      )
    },
    {
      title: t('settings.highlight.linkPattern'),
      dataIndex: 'pattern',
      ellipsis: true,
      render: (value: string, record) => {
        const { ok, message } = tryCompile(value)
        return (
          <div className="hl-pattern-cell">
            <Tooltip title={value}>
              <span className={ok ? 'hl-pattern-text' : 'hl-pattern-text hl-pattern-bad'}>{value}</span>
            </Tooltip>
            {!ok && (
              <Tooltip title={message}>
                <span className="hl-warn-icon">⚠</span>
              </Tooltip>
            )}
            {record.note != null && record.note !== '' && (
              <span className="hl-cell-note">{record.note}</span>
            )}
          </div>
        )
      }
    },
    {
      title: t('settings.highlight.linkTemplate'),
      dataIndex: 'template',
      ellipsis: true,
      render: (value: string) => (
        <Tooltip title={value}>
          <span
            className={isSafeLinkTemplate(value) ? 'hl-pattern-text' : 'hl-pattern-text hl-pattern-bad'}
          >
            {value}
          </span>
        </Tooltip>
      )
    },
    {
      title: t('settings.highlight.validation'),
      key: 'validation',
      width: 132,
      align: 'center',
      render: (_value, record) => <RuleStateTag state={linkRuleRunState(record)} />
    },
    {
      title: t('settings.highlight.actions'),
      key: 'action',
      width: 120,
      align: 'center',
      render: (_value, record) => (
        <div className="hl-actions">
          <Button size="small" onClick={() => setEditingId(record.id)}>
            {t('common.edit')}
          </Button>
          <Popconfirm
            title={t('settings.highlight.linkDeleteTitle')}
            description={t('settings.deleteConfirmDesc')}
            okText={t('common.delete')}
            cancelText={t('common.cancel')}
            okButtonProps={{ danger: true }}
            onConfirm={() =>
              void setLinkRules(
                (useSettingsStore.getState().settings.linkRules ?? EMPTY_LINK_RULES).filter(
                  (rule) => rule.id !== record.id
                )
              )
            }
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
    <div className="hl-profiles">
      <div className="hl-profiles-head">
        <span className="hl-editor-sub-label">{t('settings.highlight.linksTitle')}</span>
        <Button size="small" onClick={() => setEditingId('')}>
          {t('settings.highlight.linkAdd')}
        </Button>
      </div>
      <span className="hl-editor-hint">{t('settings.highlight.linksHint')}</span>
      <Table
        size="small"
        rowKey="id"
        columns={columns}
        dataSource={linkRules}
        pagination={false}
        locale={{ emptyText: t('settings.highlight.linkEmpty') }}
      />

      <Modal
        open={editingId !== null}
        onCancel={() => setEditingId(null)}
        onOk={() => void handleSave()}
        okText={t('common.save')}
        cancelText={t('common.cancel')}
        confirmLoading={saving}
        destroyOnHidden
        width={560}
        title={
          editing ? t('settings.highlight.linkEditTitle') : t('settings.highlight.linkCreateTitle')
        }
        okButtonProps={{ disabled: !valid }}
      >
        <div className="hl-editor">
          <div className="hl-editor-row">
            <span className="hl-editor-label">{t('settings.highlight.linkPattern')}</span>
            <div className="hl-editor-control">
              <Input.TextArea
                value={pattern}
                onChange={(e) => setPattern(e.target.value)}
                placeholder={t('settings.highlight.patternPlaceholder')}
                autoSize={{ minRows: 1, maxRows: 4 }}
                maxLength={LINK_PATTERN_MAX}
                className={compile.ok ? undefined : 'hl-editor-input-bad'}
              />
              {!compile.ok && compile.message != null && (
                <div className="hl-editor-error">{compile.message}</div>
              )}
              {compile.ok && compile.slow && (
                <div className="hl-editor-error">{t('settings.highlight.patternSlow')}</div>
              )}
              {valid && (
                <div className="hl-editor-inline">
                  {probe.state === 'probing' ? (
                    <Tag className="hl-state-tag">{t('settings.highlight.validating')}</Tag>
                  ) : (
                    <RuleStateTag state={probeState} />
                  )}
                </div>
              )}
              <span className="hl-editor-hint">{t('settings.highlight.linkPatternHint')}</span>
            </div>
          </div>
          <div className="hl-editor-row">
            <span className="hl-editor-label">{t('settings.highlight.linkTemplate')}</span>
            <div className="hl-editor-control">
              <Input
                value={template}
                onChange={(e) => setTemplate(e.target.value)}
                placeholder="https://example.com/item/$1"
                maxLength={LINK_TEMPLATE_MAX}
                className={templateOk ? undefined : 'hl-editor-input-bad'}
              />
              {!templateOk && (
                <div className="hl-editor-error">
                  {t('settings.highlight.linkInvalidTemplate')}
                </div>
              )}
              <span className="hl-editor-hint">{t('settings.highlight.linkTemplateHint')}</span>
            </div>
          </div>
          <div className="hl-editor-row">
            <span className="hl-editor-label">{t('settings.highlight.note')}</span>
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t('settings.highlight.notePlaceholder')}
              maxLength={LINK_NOTE_MAX}
            />
          </div>
          <div className="hl-editor-row">
            <span className="hl-editor-label">{t('settings.highlight.linkEnabled')}</span>
            <Switch checked={enabled} onChange={setEnabled} />
          </div>
        </div>
      </Modal>
    </div>
  )
}

function PatternCell({ rule }: { rule: HighlightRule }): React.JSX.Element {
  const { ok, message } = tryCompile(rule.pattern)
  return (
    <div className="hl-pattern-cell">
      {rule.lineAnchor === true && (
        <Tooltip title={t('settings.highlight.lineAnchor')}>
          <span className="hl-case-badge">{'^$'}</span>
        </Tooltip>
      )}
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
    lineAnchor: false,
    notify: false,
    note: undefined,
    enabled: true,
    basic: false
  })
  const [saving, setSaving] = useState(false)
  const [showBg, setShowBg] = useState(false)
  const [testText, setTestText] = useState('')

  const compile = tryCompile(draft.pattern)
  const valid = draft.pattern.trim() !== '' && compile.ok
  /** What would be saved: the pattern is trimmed on the way into the store. */
  const savedPattern = draft.pattern.trim()
  /**
   * The probe verdict for the draft. The editor never decides on its own
   * whether a pattern may run: until the main process's worker reports `passed`
   * for exactly this pattern and these flags, the draft is not previewed.
   */
  const probe = useRuleProbe({
    kind: 'highlight',
    pattern: savedPattern,
    caseInsensitive: draft.caseInsensitive,
    lineAnchor: draft.lineAnchor,
    enabled: open && valid
  })
  /**
   * The verdict the rule already holds, when it still describes exactly what the
   * form is showing. Re-opening an unchanged rule must not blank its preview for
   * the half second the fresh probe takes: the stored proof is still evidence
   * for this pattern and these flags, and the probe only refreshes it.
   */
  const seeded =
    editing !== undefined &&
    editing.pattern === savedPattern &&
    proofMatches(savedPattern, highlightFlags(draft.caseInsensitive, draft.lineAnchor), editing.validation, PROBE_VERSION)
      ? editing.validation
      : undefined
  /**
   * What the row/tag shows. `builtin` is its own state, not `pending`: the draft
   * matches a shipped preset, so the engines' whitelist lets it run — labelling
   * it "waiting for a check" would contradict the preview right below, which
   * does execute it. `previewProof` stays undefined there on purpose: there is no
   * measurement to cite, the whitelist exemption is what allows the run.
   */
  const probeState: RuleRunState =
    probe.state === 'probing' || probe.state === 'idle'
      ? (seeded?.status ?? 'pending')
      : probe.state === 'passed'
        ? 'passed'
        : probe.state === 'builtin'
          ? 'builtin'
          : probe.state === 'quarantined'
            ? 'quarantined'
            : 'pending'
  const previewProof = probeState === 'passed' ? (probe.validation ?? seeded) : undefined

  /**
   * Preview the draft rule *together with* the other rules: a span that some
   * earlier rule steals (`done`, claimed by the shell-keyword rule) then shows up
   * here rather than surprising the user in the terminal.
   */
  const previewRules = useMemo(() => {
    const draftRule: HighlightRule = {
      id: ruleId ?? 'draft',
      pattern: savedPattern,
      enabled: true,
      priority: draft.priority,
      color: { fg: draft.fg, ...(showBg && draft.bg ? { bg: draft.bg } : {}) },
      ...(draft.bands && draft.bands.length > 0 ? { bands: draft.bands } : {}),
      ...(draft.caseInsensitive ? { caseInsensitive: true } : {}),
      ...(draft.lineAnchor ? { lineAnchor: true } : {}),
      // A pending or quarantined draft carries no proof, and `compileRules`
      // fails closed without one — which is precisely "a draft that has not
      // passed is not executed", applied through the same gate the terminal
      // uses rather than a second rule invented here.
      ...(previewProof ? { validation: previewProof } : {})
    }
    const active = [...highlightRules.filter((rule) => rule.id !== ruleId), draftRule]
    // The preview has to show the colours the terminal will use, so the theme
    // mapping is applied here exactly as TerminalView applies it.
    return compileRules(themeColors ? applyThemeColors(active, theme) : active)
  }, [
    savedPattern,
    draft.priority,
    draft.fg,
    draft.bg,
    draft.bands,
    draft.caseInsensitive,
    draft.lineAnchor,
    showBg,
    highlightRules,
    ruleId,
    themeColors,
    theme,
    previewProof
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
    const lineAnchor = editing ? editing.lineAnchor === true : false
    const notify = editing ? editing.notify === true : false
    const basic = editing ? editing.basic === true : false
    const bands = editing?.bands
    const category = editing?.category
    setDraft({ pattern, priority, fg, bg, bands, category, caseInsensitive, lineAnchor, notify, note, enabled, basic })
    setShowBg(bg != null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

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
    const next = bands.map((band, i) => (i === index ? { ...band, ...partial } : band))
    // the engine applies bands in ascending min order (compileBands sorts), so
    // keep the editor rows in that same order — a stable sort keeps equal mins
    // in their entry order
    next.sort((a, b) => a.min - b.min)
    patch({ bands: next })
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
      const lineAnchor = draft.lineAnchor ? true : undefined
      const notify = draft.notify ? true : undefined
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
          lineAnchor,
          notify,
          ...(draft.basic ? { basic: true as const } : {}),
          note: draft.note?.trim() ? draft.note.trim() : undefined
        }
        // read at call time: the render-scoped array goes stale inside a React
        // batch, and another write in the same batch would silently drop the first
        const current = useSettingsStore.getState().settings.highlightRules
        await setHighlightRules([...current, rule])
      } else if (editing !== undefined) {
        // A proof belongs to the pattern and flags it was obtained for. Editing
        // either of them drops it, so the row shows `pending` immediately
        // instead of a `passed` that no longer describes the rule (the main
        // process would normalize it away anyway). An unchanged pattern and
        // flags keep the existing proof — re-saving a rule must not make it
        // stop working until it is probed again.
        const identityKept =
          editing.pattern === draft.pattern.trim() &&
          (editing.caseInsensitive === true) === draft.caseInsensitive &&
          (editing.lineAnchor === true) === draft.lineAnchor
        const rule: HighlightRule = {
          ...editing,
          pattern: draft.pattern.trim(),
          priority: draft.priority,
          enabled: draft.enabled,
          color,
          bands,
          category: draft.category,
          caseInsensitive,
          lineAnchor,
          notify,
          // explicit override (not a conditional spread): unchecking must clear
          // a basic flag the edited rule may already carry
          basic: draft.basic ? true : undefined,
          note: draft.note?.trim() ? draft.note.trim() : undefined,
          ...(identityKept ? {} : { validation: undefined })
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
              maxLength={MAX_PATTERN_LEN}
              className={compile.ok ? undefined : 'hl-editor-input-bad'}
            />
            {!compile.ok && compile.message != null && (
              <div className="hl-editor-error">{compile.message}</div>
            )}
            {compile.ok && compile.slow && (
              <div className="hl-editor-error">{t('settings.highlight.patternSlow')}</div>
            )}
            {valid && (
              <div className="hl-editor-inline">
                {probe.state === 'probing' ? (
                  <Tag className="hl-state-tag">{t('settings.highlight.validating')}</Tag>
                ) : (
                  <RuleStateTag state={probeState} />
                )}
                {probe.state === 'passed' && probe.ms !== undefined && (
                  <span className="hl-editor-hint">{formatMs(probe.ms)}</span>
                )}
              </div>
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
            <div className="hl-editor-inline">
              <Switch
                size="small"
                checked={draft.lineAnchor}
                onChange={(c) => patch({ lineAnchor: c })}
              />
              <span className="hl-editor-sub-label">{t('settings.highlight.lineAnchor')}</span>
              <span className="hl-editor-hint">{t('settings.highlight.lineAnchorHint')}</span>
            </div>
            <div className="hl-editor-inline">
              <Switch
                size="small"
                checked={draft.notify}
                onChange={(c) => patch({ notify: c })}
              />
              <span className="hl-editor-sub-label">{t('settings.highlight.notify')}</span>
              <span className="hl-editor-hint">{t('settings.highlight.notifyHint')}</span>
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
            {valid && probeState !== 'passed' && probeState !== 'builtin' && (
              <div className="hl-editor-hint">{t('settings.highlight.pendingPreview')}</div>
            )}
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
                  <Button
                    size="small"
                    onClick={() => {
                      patch({ bg: undefined })
                      setShowBg(false)
                    }}
                  >
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
          <span className="hl-editor-label">{t('settings.highlight.basic')}</span>
          <Switch checked={draft.basic} onChange={(c) => patch({ basic: c })} />
          <span className="hl-editor-hint">{t('settings.highlight.basicHint')}</span>
        </div>

        <div className="hl-editor-row">
          <span className="hl-editor-label">{t('settings.highlight.enabled')}</span>
          <Switch checked={draft.enabled} onChange={(c) => patch({ enabled: c })} />
        </div>

        {/* Right above the save button, where the decision is made: a
            quarantined rule can be saved and edited, but it will not run. */}
        {valid && probeState === 'quarantined' && (
          <Alert
            type="warning"
            showIcon
            className="hl-probe-alert"
            message={t('settings.highlight.state.quarantinedHint')}
          />
        )}
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