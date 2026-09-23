import { useEffect, useMemo, useState } from 'react'
import { Alert, Button, Form, Input, InputNumber, Modal, Radio, Select } from 'antd'
import type { SshAuthMethod, SshConnection, SshConnectionInput } from '@shared/connections'
import { getLanguage, t } from '@shared/i18n'
import { useSettingsStore } from '@renderer/settings/store'
import { AuthFieldsRenderer } from './Fields'
import { buildInput, num, hasSavedKind, type SecretKind } from './Common'

export interface ConnectionEditDialogProps {
  open: boolean
  /** connection being edited; null = create new */
  editing: SshConnection | null
  onClose: () => void
  onSaved: () => void
}

/**
 * Modal for creating / editing an SSH bookmark.
 *
 * Secret handling: the form holds only what the user typed. On edit, secret
 * inputs start empty and stay empty to mean "keep the stored value" — those
 * fields are simply omitted from the save payload (see buildInput). No secret
 * plaintext is ever written to the console or logs.
 */
export function ConnectionEditDialog({
  open,
  editing,
  onClose,
  onSaved
}: ConnectionEditDialogProps): React.JSX.Element {
  const [form] = Form.useForm<SshConnectionInput>()
  const [saving, setSaving] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [auth, setAuth] = useState<SshAuthMethod>('password')

  /** Editing target identity; re-initializes the form when it changes. */
  const editKey = editing?.id ?? 'new'

  // Unique group names from all saved connections, for the group Select.
  const [groupOptions, setGroupOptions] = useState<string[]>([])
  useEffect(() => {
    if (!open) return
    window.api
      .listConnections()
      .then((conns: SshConnection[]) => {
        const seen = new Set<string>()
        for (const c of conns) {
          if (c.group) seen.add(c.group)
        }
        setGroupOptions([...seen].sort())
      })
      .catch(() => {
        // sidebar keeps its own list; a transient failure here just leaves the
        // group field as a plain text input
        setGroupOptions([])
      })
  }, [open])

  // Named highlight-rule subsets defined in Settings, for the profile Select.
  const highlightProfiles = useSettingsStore((s) => s.settings.highlightProfiles)

  // Populate / clear the form for each open + target change.
  useEffect(() => {
    if (!open) return
    setErrorMsg(null)
    const base: SshAuthMethod = editing?.auth ?? 'password'
    setAuth(base)
    // Fields keep their value when unmounted (rc-form preserve: true), so the
    // secrets below must be cleared explicitly — otherwise a password typed for
    // connection A survives into connection B's save. resetFields() drops every
    // stored value; setFieldsValue() then re-seeds the non-secret fields.
    form.resetFields()
    form.setFieldsValue({
      name: editing?.name,
      group: editing?.group,
      host: editing?.host,
      port: editing?.port,
      username: editing?.username,
      auth: base,
      askPasswordAtConnect: editing?.askPasswordAtConnect,
      askPassphraseAtConnect: editing?.askPassphraseAtConnect,
      keyPath: editing?.keyPath,
      keepaliveIntervalSec: editing?.keepaliveIntervalSec,
      highlightProfileId: editing?.highlightProfileId
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editKey, form])

  const handleSave = async (): Promise<void> => {
    const values = await form.validateFields()
    const input = buildInput(values as unknown as Record<string, unknown>, {
      conn: editing
    })
    setSaving(true)
    setErrorMsg(null)
    try {
      await window.api.saveConnection(input)
      onSaved()
      onClose()
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : t('ssh.dialog.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  const handleCancel = (): void => {
    if (!saving) onClose()
  }

  /** Active language; a dep of the memo below so translated labels refresh. */
  const language = getLanguage()

  const savedNotes = useMemo(() => {
    if (!editing) return []
    const kinds: Array<{ kind: SecretKind; label: string }> = [
      { kind: 'password', label: t('ssh.auth.password') },
      { kind: 'keyContent', label: t('ssh.auth.privateKey') },
      { kind: 'passphrase', label: t('ssh.secret.passphrase') }
    ]
    const active = auth === 'password' ? ['password'] : auth === 'privateKey' ? ['keyContent', 'passphrase'] : []
    return kinds.filter((k) => active.includes(k.kind) && hasSavedKind(k.kind, editing.savedAuth))
  }, [editing, auth, language])

  return (
    <Modal
      open={open}
      title={editing ? t('ssh.dialog.titleEdit') : t('ssh.dialog.titleNew')}
      width={520}
      onCancel={handleCancel}
      destroyOnHidden
      footer={
        <div className="connections-dialog-footer">
          <span className="connections-dialog-error">{errorMsg}</span>
          <Button onClick={onClose} disabled={saving} style={{ marginRight: 8 }}>
            {t('common.cancel')}
          </Button>
          <Button type="primary" loading={saving} onClick={() => void handleSave()}>
            {t('common.save')}
          </Button>
        </div>
      }
    >
      <Form
        className="connections-dialog-form"
        form={form}
        layout="vertical"
        requiredMark
        onFinish={() => void handleSave()}
      >
        <Form.Item
          name="name"
          label={t('ssh.dialog.name')}
          rules={[{ required: true, whitespace: true, message: t('ssh.dialog.nameRequired') }]}
        >
          <Input placeholder={t('ssh.dialog.namePlaceholder')} autoComplete="off" />
        </Form.Item>

        <Form.Item name="group" label={t('ssh.dialog.group')}>
          <Select
            allowClear
            mode="tags"
            placeholder={t('ssh.dialog.groupPlaceholder')}
            options={groupOptions.map((g) => ({ value: g, label: g }))}
            maxCount={1}
          />
        </Form.Item>

        <Form.Item
          name="host"
          label={t('ssh.dialog.host')}
          rules={[{ required: true, whitespace: true, message: t('ssh.dialog.hostRequired') }]}
        >
          <Input placeholder={t('ssh.dialog.hostPlaceholder')} autoComplete="off" />
        </Form.Item>

        <Form.Item
          name="port"
          label={t('ssh.dialog.port')}
          rules={[{ type: 'number', min: 1, max: 65535, message: t('ssh.dialog.portRange') }]}
        >
          <InputNumber className="connections-port-input" min={1} max={65535} placeholder="22" />
        </Form.Item>

        <Form.Item
          name="username"
          label={t('ssh.dialog.username')}
          rules={[{ required: true, whitespace: true, message: t('ssh.dialog.usernameRequired') }]}
        >
          <Input placeholder="root" autoComplete="off" />
        </Form.Item>

        <Form.Item name="auth" label={t('ssh.dialog.authMethod')}>
          <Radio.Group onChange={(e) => setAuth(e.target.value as SshAuthMethod)}>
            <Radio value="password">{t('ssh.auth.password')}</Radio>
            <Radio value="privateKey">{t('ssh.auth.privateKey')}</Radio>
            <Radio value="agent">{t('ssh.auth.agent')}</Radio>
          </Radio.Group>
        </Form.Item>

        {savedNotes.length > 0 &&
          savedNotes.map((n) => (
            <Alert
              key={n.kind}
              type="info"
              showIcon
              className="connections-secret-note"
              message={t('ssh.dialog.savedSecret', { kind: n.label })}
            />
          ))}

        <AuthFieldsRenderer auth={auth} />

        <Form.Item
          name="keepaliveIntervalSec"
          label={t('ssh.dialog.keepalive')}
          tooltip={t('ssh.dialog.keepaliveTooltip')}
          rules={[{ type: 'number', min: 0, message: t('ssh.dialog.keepaliveMin') }]}
        >
          <InputNumber className="connections-keepalive-input" min={0} placeholder="30" />
        </Form.Item>

        <Form.Item name="highlightProfileId" label={t('ssh.dialog.highlightProfile')}>
          <Select
            allowClear
            placeholder={t('ssh.dialog.highlightProfileDefault')}
            options={highlightProfiles.map((p) => ({ value: p.id, label: p.name }))}
          />
        </Form.Item>
      </Form>
    </Modal>
  )
}