import { Alert, Button, Modal } from 'antd'
import type { HostKeyPromptEvent } from '@shared/connections'
import { t } from '@shared/i18n'

/**
 * Host key verification dialog. Shown one at a time (Workspace keeps a FIFO
 * queue and renders the head) for the two distinct cases:
 *
 *   - 'new'     → first time we see this host: show host:port + fingerprint.
 *   - 'changed' → the stored fingerprint no longer matches: red warning header
 *                 about a possible man-in-the-middle attack.
 *
 * The decision is returned to the caller, which commits it through
 * `window.api.respondHostKey(promptId, action)`.
 */

export interface HostKeyModalProps {
  event: HostKeyPromptEvent
  onDecision: (action: 'accept' | 'reject') => void
}

export function HostKeyModal({ event, onDecision }: HostKeyModalProps): React.JSX.Element {
  const isChanged = event.reason === 'changed'
  const target = `${event.host}:${event.port}`

  return (
    <Modal
      open
      title={
        isChanged ? (
          <div className="hostkey-changed-title">{t('ssh.hostKey.changedTitle')}</div>
        ) : (
          t('ssh.hostKey.unknownHost')
        )
      }
      okText={t('ssh.hostKey.accept')}
      cancelText={t('ssh.hostKey.reject')}
      okButtonProps={isChanged ? { danger: true } : { type: 'primary' }}
      cancelButtonProps={{ danger: !isChanged }}
      onOk={() => onDecision('accept')}
      onCancel={() => onDecision('reject')}
      width={480}
    >
      <div className="hostkey-body">
        {isChanged ? (
          <Alert
            type="warning"
            showIcon
            message={t('ssh.hostKey.mitmTitle')}
            description={t('ssh.hostKey.mitmDesc')}
          />
        ) : (
          <div className="hostkey-desc">{t('ssh.hostKey.firstConnect')}</div>
        )}

        <div className="hostkey-target">{t('ssh.hostKey.target', { target })}</div>
        <div className="hostkey-fingerprint">
          {t('ssh.hostKey.fingerprint', { fingerprint: event.fingerprint })}
        </div>
      </div>
    </Modal>
  )
}