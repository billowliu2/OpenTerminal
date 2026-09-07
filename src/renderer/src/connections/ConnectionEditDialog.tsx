import { useEffect, useMemo, useState } from 'react'
import { Alert, Button, Form, Input, InputNumber, Modal, Radio, Select } from 'antd'
import type { SshAuthMethod, SshConnection, SshConnectionInput } from '@shared/connections'
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

  // Populate / clear the form for each open + target change.
  useEffect(() => {
    if (!open) return
    setErrorMsg(null)
    const base: SshAuthMethod = editing?.auth ?? 'password'
    setAuth(base)
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
      keepaliveIntervalSec: editing?.keepaliveIntervalSec
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
      setErrorMsg(err instanceof Error ? err.message : '保存失败，请检查输入后重试')
    } finally {
      setSaving(false)
    }
  }

  const handleCancel = (): void => {
    if (!saving) onClose()
  }

  const savedNotes = useMemo(() => {
    if (!editing) return []
    const kinds: Array<{ kind: SecretKind; label: string }> = [
      { kind: 'password', label: '密码' },
      { kind: 'keyContent', label: '私钥' },
      { kind: 'passphrase', label: '口令' }
    ]
    const active = auth === 'password' ? ['password'] : auth === 'privateKey' ? ['keyContent', 'passphrase'] : []
    return kinds.filter((k) => active.includes(k.kind) && hasSavedKind(k.kind, editing.savedAuth))
  }, [editing, auth])

  return (
    <Modal
      open={open}
      title={editing ? '编辑连接' : '新建连接'}
      width={520}
      onCancel={handleCancel}
      destroyOnHidden
      footer={
        <div className="connections-dialog-footer">
          <span className="connections-dialog-error">{errorMsg}</span>
          <Button onClick={onClose} disabled={saving} style={{ marginRight: 8 }}>
            取消
          </Button>
          <Button type="primary" loading={saving} onClick={() => void handleSave()}>
            保存
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
          label="名称"
          rules={[{ required: true, whitespace: true, message: '请输入连接名称' }]}
        >
          <Input placeholder="例如：生产服务器" autoComplete="off" />
        </Form.Item>

        <Form.Item name="group" label="分组">
          <Select
            allowClear
            mode="tags"
            placeholder="选择或输入新分组，留空归入“默认”"
            options={groupOptions.map((g) => ({ value: g, label: g }))}
            maxCount={1}
          />
        </Form.Item>

        <Form.Item
          name="host"
          label="主机"
          rules={[{ required: true, whitespace: true, message: '请输入主机地址' }]}
        >
          <Input placeholder="192.168.1.10 或 example.com" autoComplete="off" />
        </Form.Item>

        <Form.Item
          name="port"
          label="端口"
          rules={[{ type: 'number', min: 1, max: 65535, message: '端口需在 1–65535 之间' }]}
        >
          <InputNumber className="connections-port-input" min={1} max={65535} placeholder="22" />
        </Form.Item>

        <Form.Item
          name="username"
          label="用户名"
          rules={[{ required: true, whitespace: true, message: '请输入用户名' }]}
        >
          <Input placeholder="root" autoComplete="off" />
        </Form.Item>

        <Form.Item name="auth" label="认证方式">
          <Radio.Group onChange={(e) => setAuth(e.target.value as SshAuthMethod)}>
            <Radio value="password">密码</Radio>
            <Radio value="privateKey">私钥</Radio>
            <Radio value="agent">Agent</Radio>
          </Radio.Group>
        </Form.Item>

        {savedNotes.length > 0 &&
          savedNotes.map((n) => (
            <Alert
              key={n.kind}
              type="info"
              showIcon
              className="connections-secret-note"
              message={`已保存${n.label}，留空将保留原值`}
            />
          ))}

        <AuthFieldsRenderer auth={auth} />

        <Form.Item
          name="keepaliveIntervalSec"
          label="Keepalive 间隔（秒）"
          tooltip="0 表示关闭 keepalive"
          rules={[{ type: 'number', min: 0, message: '不能为负数' }]}
        >
          <InputNumber className="connections-keepalive-input" min={0} placeholder="30" />
        </Form.Item>
      </Form>
    </Modal>
  )
}