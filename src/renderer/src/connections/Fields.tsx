import { Form, Input, Switch } from 'antd'
import useFormInstance from 'antd/es/form/hooks/useFormInstance'
import { useWatch } from 'antd/es/form/Form'
import type { SshAuthMethod } from '@shared/connections'

/**
 * Auth-method dependent fields rendered inside the edit dialog's <Form>.
 * Secret inputs (password / key content / passphrase) are controlled Form
 * state only — they never enter connection objects shown elsewhere, and no
 * plaintext is ever logged here.
 */

export function AuthFieldsRenderer({ auth }: { auth: SshAuthMethod }): React.JSX.Element {
  const form = useFormInstance()
  const askPasswordAtConnect = useWatch('askPasswordAtConnect', form) ?? false
  const askPassphraseAtConnect = useWatch('askPassphraseAtConnect', form) ?? false

  if (auth === 'agent') {
    return <div className="connections-auth-desc">使用本机 SSH Agent 中已加载的密钥进行认证，无需在本应用内保存任何密钥。</div>
  }

  return (
    <div className="connections-secret-section">
      {auth === 'password' ? (
        <>
          <SwitchRow
            name="askPasswordAtConnect"
            label="连接时询问密码"
            hint="开启后每次连接弹出对话框输入密码，不再使用已保存的密码"
          />
          {!askPasswordAtConnect && (
            <Form.Item name="password" label="密码" className="connections-secret-item">
              <Input.Password placeholder="编辑时留空表示保留已保存的密码" autoComplete="off" />
            </Form.Item>
          )}
        </>
      ) : (
        <>
          <Form.Item name="keyPath" label="私钥路径（服务器上的本地私钥路径，可留空）">
            <Input placeholder="/home/me/.ssh/id_rsa" autoComplete="off" />
          </Form.Item>
          <Form.Item name="keyContent" label="私钥内容">
            <Input.TextArea
              rows={4}
              placeholder="粘贴私钥内容；留空则使用上面的路径（编辑时留空表示保留已保存的私钥）"
              autoComplete="off"
              spellCheck={false}
            />
          </Form.Item>
          <SwitchRow
            name="askPassphraseAtConnect"
            label="连接时询问口令"
            hint="开启后每次连接提示输入私钥口令"
          />
          {!askPassphraseAtConnect && (
            <Form.Item name="passphrase" label="私钥口令" className="connections-secret-item">
              <Input.Password placeholder="编辑时留空表示保留已保存的口令" autoComplete="off" />
            </Form.Item>
          )}
        </>
      )}
    </div>
  )
}

function SwitchRow({
  name,
  label,
  hint
}: {
  name: 'askPasswordAtConnect' | 'askPassphraseAtConnect'
  label: string
  hint: string
}): React.JSX.Element {
  const form = useFormInstance()
  const checked = useWatch(name, form) ?? false
  const set = (next: boolean): void => {
    form.setFieldValue(name, next)
  }
  return (
    <div className="connections-switch-row">
      <span>
        <span className="connections-switch-label">{label}</span>
        <div className="connections-switch-hint">{hint}</div>
      </span>
      <Switch checked={checked} onChange={set} size="small" />
    </div>
  )
}