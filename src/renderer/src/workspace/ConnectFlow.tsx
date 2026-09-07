import { useState } from 'react'
import { Button, Input, Modal } from 'antd'
import { LoadingOutlined } from '@ant-design/icons'
import type { SshConnection, SshSecretOverride } from '@shared/connections'

/**
 * Connect-time gateways for one SSH connection attempt.
 *
 * `phase` drives which dialog shows:
 *   - 'secret'     → secret prompt modal (password when `askPasswordAtConnect`,
 *                    passphrase when `askPassphraseAtConnect`). This is the only
 *                    connect-time dialog that can be cancelled, because
 *                    openSession cannot be aborted before it resolves.
 *   - 'connecting' → an uncancellable "连接中…" modal while openSession flies.
 *
 * Workspace moves `phase` secret→connecting when the secret is confirmed and
 * back to null when the attempt settles. Each dialog is `key`-ed by the
 * connection id so a new attempt never inherits previously typed secrets.
 */

export type ConnectStage = 'idle' | 'password' | 'passphrase' | 'connecting'

export interface ConnectFlowProps {
  /** one pending double-click request; null clears the flow */
  conn: SshConnection | null
  /** 'connecting' once a secret (if any) has been committed and openSession started */
  phase: 'secret' | 'connecting'
  onConfirmed: (secretOverride: SshSecretOverride) => void
  onCancel: () => void
}

export function ConnectFlow({ conn, phase, onConfirmed, onCancel }: ConnectFlowProps): React.JSX.Element {
  const [password, setPassword] = useState('')
  const [passphrase, setPassphrase] = useState('')

  const stage: ConnectStage =
    conn == null
      ? 'idle'
      : phase === 'connecting'
        ? 'connecting'
        : conn.askPasswordAtConnect
          ? 'password'
          : conn.askPassphraseAtConnect
            ? 'passphrase'
            : 'connecting'

  // A fresh connection must not inherit a previous attempt's typed value, so
  // each stage modal carries a per-connection `key` that forces a new mount.
  const key = conn?.id ?? 'none'

  if (conn == null) return <></>

  if (stage === 'password') {
    return (
      <SecretModal
        key={key}
        title="输入连接密码"
        description={`${conn.username}@${conn.host}:${conn.port}`}
        placeholder="密码"
        value={password}
        onChange={(v) => setPassword(v)}
        onOk={() => onConfirmed({ password })}
        onCancel={onCancel}
      />
    )
  }

  if (stage === 'passphrase') {
    return (
      <SecretModal
        key={key}
        title="输入私钥口令"
        description={`${conn.username}@${conn.host}:${conn.port}`}
        placeholder="私钥口令"
        value={passphrase}
        onChange={(v) => setPassphrase(v)}
        onOk={() => onConfirmed({ passphrase })}
        onCancel={onCancel}
      />
    )
  }

  if (stage === 'connecting') {
    return (
      <Modal
        key={key}
        open
        title="连接中…"
        closable={false}
        maskClosable={false}
        keyboard={false}
        footer={null}
        width={320}
      >
        <div className="connect-flow-connecting">
          <LoadingOutlined spin style={{ fontSize: 26 }} />
          <span className="connect-flow-connecting-text">
            正在连接 {conn?.name != null ? conn.name : '…'}
          </span>
        </div>
      </Modal>
    )
  }

  return <></>
}

function SecretModal({
  key,
  title,
  description,
  placeholder,
  value,
  onChange,
  onOk,
  onCancel
}: {
  /** forces per-connection mount */
  key: string
  title: string
  description: string
  placeholder: string
  value: string
  onChange: (value: string) => void
  onOk: () => void
  onCancel: () => void
}): React.JSX.Element {
  const [submitting, setSubmitting] = useState(false)

  const handleOk = (): void => {
    setSubmitting(true)
    onOk()
  }

  return (
    <Modal
      key={key}
      open
      title={title}
      okText="连接"
      cancelText="取消"
      onOk={handleOk}
      onCancel={onCancel}
      confirmLoading={submitting}
      destroyOnHidden
      width={380}
    >
      <div className="connect-flow-secret">
        <div className="connect-flow-secret-target">{description}</div>
        <Input.Password
          autoFocus
          autoComplete="off"
          placeholder={placeholder}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onPressEnter={handleOk}
          disabled={submitting}
        />
      </div>
    </Modal>
  )
}

/**
 * Small "连接中…" indicator rendered in the toolbar while a connection attempt
 * is in flight.
 */
export function ConnectSpinnerButton({ busy }: { busy: boolean }): React.JSX.Element | null {
  return busy ? (
    <Button size="small" type="text" disabled className="workspace-connect-busy-button">
      <LoadingOutlined spin />
      连接中…
    </Button>
  ) : null
}