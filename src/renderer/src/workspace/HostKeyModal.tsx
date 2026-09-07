import { Alert, Button, Modal } from 'antd'
import type { HostKeyPromptEvent } from '@shared/connections'

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
          <div className="hostkey-changed-title">主机指纹已变更！</div>
        ) : (
          '未知主机'
        )
      }
      okText="接受并连接"
      cancelText="拒绝"
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
            message="可能遭受中间人攻击"
            description="远程主机的密钥指纹与之前记录的不一致。如果这不是你本人更换了服务器密钥，可能有人正在冒充该主机。"
          />
        ) : (
          <div className="hostkey-desc">首次连接该主机，尚未记录其指纹。</div>
        )}

        <div className="hostkey-target">主机：{target}</div>
        <div className="hostkey-fingerprint">指纹：{event.fingerprint}</div>
      </div>
    </Modal>
  )
}