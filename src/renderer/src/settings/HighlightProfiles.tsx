import { useEffect, useState } from 'react'
import { Button, Checkbox, Input, Modal, Popconfirm, Switch, Table, Tooltip } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { t } from '@shared/i18n'
import { excludedByProfile } from '@shared/highlightProfiles'
import type { HighlightProfile } from '@shared/settings'
import { ruleLabel } from './ruleLabel'
import { useSettingsStore } from './store'

/**
 * Named subsets of the highlight rules ("profiles"), plus the switch that makes
 * them apply. A connection bound to a profile runs only that subset, which is how
 * a production host gets a quieter set than a local shell. Nothing here affects a
 * session until `highlightPerHost` is on and the connection is bound.
 */
export function HighlightProfiles(): React.JSX.Element {
  const profiles = useSettingsStore((s) => s.settings.highlightProfiles)
  const rules = useSettingsStore((s) => s.settings.highlightRules)
  const setHighlightProfiles = useSettingsStore((s) => s.setHighlightProfiles)
  const perHost = useSettingsStore((s) => s.settings.terminal.highlightPerHost)
  const updateTerminal = useSettingsStore((s) => s.updateTerminal)

  /** null = dialog closed; '' = creating; otherwise the profile being edited. */
  const [editingId, setEditingId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [ruleIds, setRuleIds] = useState<string[]>([])
  const [saving, setSaving] = useState(false)

  const editing = profiles.find((profile) => profile.id === editingId)

  // seed the dialog each time it opens
  useEffect(() => {
    if (editingId === null) return
    setName(editing?.name ?? '')
    setRuleIds(editing?.ruleIds ?? [])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingId])

  const handleSave = async (): Promise<void> => {
    if (name.trim() === '') return
    setSaving(true)
    try {
      // read at call time: the render-scoped array goes stale inside a React
      // batch, and two writes in one batch would silently drop the first
      const current = useSettingsStore.getState().settings.highlightProfiles
      const target = editingId !== null && editingId !== '' ? current.find((profile) => profile.id === editingId) : undefined
      const next = target
        ? current.map((profile) =>
            profile.id === target.id ? { ...profile, name: name.trim(), ruleIds } : profile
          )
        : [...current, { id: crypto.randomUUID(), name: name.trim(), ruleIds }]
      await setHighlightProfiles(next)
      setEditingId(null)
    } finally {
      setSaving(false)
    }
  }

  /**
   * What the current selection leaves out, shown under the checkboxes so the
   * user sees which rules a host bound to this profile will NOT run. An empty
   * selection means "all rules", so nothing is excluded by definition.
   */
  const excluded =
    ruleIds.length > 0 && ruleIds.length < rules.length
      ? excludedByProfile(rules, { id: editingId ?? '', name, ruleIds })
      : []

  const columns: ColumnsType<HighlightProfile> = [
    {
      title: t('settings.highlight.profileName'),
      dataIndex: 'name',
      ellipsis: true
    },
    {
      title: t('settings.highlight.profileRules'),
      dataIndex: 'ruleIds',
      width: 120,
      align: 'center',
      render: (ids: string[]) => (
        <span className="hl-cell-note">
          {ids.length === 0 ? t('settings.highlight.modeAll') : ids.length}
        </span>
      )
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
            title={t('settings.highlight.profileDeleteTitle')}
            description={t('settings.deleteConfirmDesc')}
            okText={t('common.delete')}
            cancelText={t('common.cancel')}
            okButtonProps={{ danger: true }}
            onConfirm={() =>
              void setHighlightProfiles(
                useSettingsStore.getState().settings.highlightProfiles.filter((p) => p.id !== record.id)
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
        <Tooltip title={t('settings.highlight.perHostHint')}>
          <span className="hl-master">
            <Switch
              size="small"
              checked={perHost}
              onChange={(checked) => void updateTerminal({ highlightPerHost: checked })}
            />
            <span className="hl-editor-sub-label">{t('settings.highlight.perHost')}</span>
          </span>
        </Tooltip>
        <Button size="small" onClick={() => setEditingId('')}>
          {t('settings.highlight.profileNew')}
        </Button>
      </div>
      <span className="hl-editor-hint">{t('settings.highlight.profilesHint')}</span>
      <Table
        size="small"
        rowKey="id"
        columns={columns}
        dataSource={profiles}
        pagination={false}
        locale={{ emptyText: t('settings.highlight.profileEmpty') }}
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
        title={editing ? t('settings.highlight.profileEdit') : t('settings.highlight.profileNew')}
        okButtonProps={{ disabled: name.trim() === '' }}
      >
        <div className="hl-editor">
          <div className="hl-editor-row">
            <span className="hl-editor-label">{t('settings.highlight.profileName')}</span>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('settings.highlight.profileNamePlaceholder')}
              maxLength={40}
            />
          </div>
          <div className="hl-editor-row">
            <span className="hl-editor-label">{t('settings.highlight.profileRules')}</span>
            <div className="hl-editor-control">
              <span className="hl-editor-hint">{t('settings.highlight.profileRulesHint')}</span>
              <Checkbox.Group
                className="hl-profile-rules"
                value={ruleIds}
                onChange={(values) => setRuleIds(values as string[])}
                options={rules.map((rule) => ({ value: rule.id, label: ruleLabel(rule) }))}
              />
              {excluded.length > 0 && (
                <span className="hl-editor-hint">
                  {t('settings.highlight.profileExcluded', {
                    n: excluded.length,
                    list: excluded.map((rule) => ruleLabel(rule)).join('; ')
                  })}
                </span>
              )}
            </div>
          </div>
        </div>
      </Modal>
    </div>
  )
}
