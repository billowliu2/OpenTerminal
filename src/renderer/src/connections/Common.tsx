import type { SshAuthMethod, SshConnection, SshConnectionInput, SshSavedAuthFlags } from '@shared/connections'

/**
 * Shared helpers for the connection manager UI (connections/**, renderer).
 * Nothing here ever holds secret plaintext; secrets live only in the dialog's
 * controlled Form state and are stripped before anything is passed around.
 */

/** Numeric parse for InputNumber stores: undefined/'' → null, else Number(). */
export function num(v: unknown): number | null {
  if (v == null || v === '') return null
  return Number(v)
}

export type SecretKind = 'password' | 'keyContent' | 'passphrase'

export function hasSavedKind(kind: SecretKind, savedAuth: SshSavedAuthFlags | undefined): boolean {
  if (!savedAuth) return false
  if (kind === 'password') return savedAuth.hasPassword
  if (kind === 'keyContent') return savedAuth.hasKeyContent
  return savedAuth.hasPassphrase
}

export function authLabel(kind: SshAuthMethod): string {
  return kind === 'privateKey' ? '私钥' : kind === 'agent' ? 'Agent' : '密码'
}

export function AuthTags({ auth }: { auth: SshAuthMethod }): React.JSX.Element {
  return <span className="connections-auth-badge">{authLabel(auth)}</span>
}

export interface BuildCtx {
  /** present when editing; its id is reused for the update */
  conn?: SshConnection | null
}

/**
 * Build the renderer→main save payload from raw Form values.
 * Secret fields are included ONLY when a non-empty value was typed; an empty
 * value means "keep the previously stored one" and the key is simply omitted,
 * so no plaintext secret is ever passed through this path on edit.
 */
export function buildInput(values: Record<string, unknown>, ctx: BuildCtx): SshConnectionInput {
  const auth = values.auth as SshAuthMethod
  const askPasswordAtConnect = Boolean(values.askPasswordAtConnect)
  const askPassphraseAtConnect = Boolean(values.askPassphraseAtConnect)

  const rawGroup = values.group
  const group = Array.isArray(rawGroup)
    ? rawGroup.find((g): g is string => typeof g === 'string' && g.trim() !== '')
    : typeof rawGroup === 'string' && rawGroup.trim() !== ''
      ? rawGroup.trim()
      : undefined

  const input: SshConnectionInput = {
    id: ctx.conn?.id,
    name: String(values.name ?? '').trim(),
    host: String(values.host ?? '').trim(),
    port: num(values.port) ?? 22,
    username: String(values.username ?? '').trim(),
    auth,
    askPasswordAtConnect,
    askPassphraseAtConnect,
    keepaliveIntervalSec: num(values.keepaliveIntervalSec) ?? 30,
    group
  }

  const secret = (key: SecretKind): string | undefined => {
    const raw = values[key]
    return typeof raw === 'string' && raw.trim() !== '' ? raw : undefined
  }

  if (auth === 'password') {
    if (!askPasswordAtConnect) input.password = secret('password')
  } else if (auth === 'privateKey') {
    if (typeof values.keyPath === 'string' && values.keyPath.trim() !== '') {
      input.keyPath = values.keyPath.trim()
    }
    input.keyContent = secret('keyContent')
    if (!askPassphraseAtConnect) input.passphrase = secret('passphrase')
  }
  // agent: no secret fields in the input
  return input
}