import { Form, Input, Switch } from 'antd'
import useFormInstance from 'antd/es/form/hooks/useFormInstance'
import { useWatch } from 'antd/es/form/Form'
import type { SshAuthMethod } from '@shared/connections'
import { t } from '@shared/i18n'

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
    return <div className="connections-auth-desc">{t('ssh.fields.agentDesc')}</div>
  }

  return (
    <div className="connections-secret-section">
      {auth === 'password' ? (
        <>
          <SwitchRow
            name="askPasswordAtConnect"
            label={t('ssh.fields.askPasswordLabel')}
            hint={t('ssh.fields.askPasswordHint')}
          />
          {!askPasswordAtConnect && (
            <Form.Item name="password" label={t('ssh.auth.password')} className="connections-secret-item">
              <Input.Password placeholder={t('ssh.fields.passwordPlaceholder')} autoComplete="off" />
            </Form.Item>
          )}
        </>
      ) : (
        <>
          <Form.Item name="keyPath" label={t('ssh.fields.keyPath')}>
            <Input placeholder="/home/me/.ssh/id_rsa" autoComplete="off" />
          </Form.Item>
          <Form.Item name="keyContent" label={t('ssh.fields.keyContent')}>
            <Input.TextArea
              rows={4}
              placeholder={t('ssh.fields.keyContentPlaceholder')}
              autoComplete="off"
              spellCheck={false}
            />
          </Form.Item>
          <SwitchRow
            name="askPassphraseAtConnect"
            label={t('ssh.fields.askPassphraseLabel')}
            hint={t('ssh.fields.askPassphraseHint')}
          />
          {!askPassphraseAtConnect && (
            <Form.Item name="passphrase" label={t('ssh.fields.passphrase')} className="connections-secret-item">
              <Input.Password placeholder={t('ssh.fields.passphrasePlaceholder')} autoComplete="off" />
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