import type { LayoutMeta } from './ipc'

/**
 * SSH connection model. Secrets (password / key content / passphrase) are only
 * ever persisted encrypted (Electron safeStorage, base64) inside the main
 * process. The renderer receives connections with secret fields stripped and
 * replaced by the `savedAuth` flags, so plaintext secrets never cross the
 * contextBridge.
 */

export type SshAuthMethod = 'password' | 'privateKey' | 'agent'

export interface SshSavedAuthFlags {
  hasPassword: boolean
  hasKeyContent: boolean
  hasPassphrase: boolean
}

export interface SshConnection {
  id: string
  name: string
  /** optional group for the bookmark tree; undefined = root */
  group?: string
  host: string
  port: number
  username: string
  auth: SshAuthMethod
  /** prompt for password in a dialog at connect time instead of using the stored one */
  askPasswordAtConnect: boolean
  /** prompt for key passphrase at connect time */
  askPassphraseAtConnect: boolean
  keyPath?: string
  /** seconds between keepalive packets; 0 disables */
  keepaliveIntervalSec: number
  createdAt: number
  lastConnectedAt?: number
  savedAuth: SshSavedAuthFlags
  /** highlight profile bound to this host; absent = run every rule */
  highlightProfileId?: string
}

/** Renderer-supplied connection data on save; secrets here are plaintext on purpose (one-way, encrypted before persisting). */
export interface SshConnectionInput {
  id?: string
  name: string
  group?: string
  host: string
  port: number
  username: string
  auth: SshAuthMethod
  askPasswordAtConnect: boolean
  askPassphraseAtConnect: boolean
  keyPath?: string
  keepaliveIntervalSec: number
  /** highlight profile bound to this host; absent = run every rule */
  highlightProfileId?: string
  /** plain password to store; omit to keep the previously stored one */
  password?: string
  /** private key content to store inline; omit to keep the previously stored one */
  keyContent?: string
  passphrase?: string
}

/** Secrets typed at connect time when ask*AtConnect is set. */
export interface SshSecretOverride {
  password?: string
  passphrase?: string
}

/** The secret kind a connection must prompt for before connecting. */
export type ConnectPromptKind = 'password' | 'passphrase'

/**
 * Which secret dialog (if any) a connect attempt for `conn` must show first.
 *
 * Single source of truth for Workspace's `handleConnectRequest` and
 * ConnectFlow's stage selection: both used to derive it independently and the
 * renderer-only check on ConnectFlow's side ignored `auth`, so a key-auth
 * bookmark with a stale `askPasswordAtConnect` flag (left over from an edit
 * that switched auth methods) popped a password dialog.
 *
 * Each ask* flag only counts for the auth method it belongs to; `null` means
 * saved credentials exist and the connection must start immediately (existing
 * UX — such connections must never route through the secret prompt).
 */
export function connectPromptFor(conn: SshConnection): ConnectPromptKind | null {
  if (conn.auth === 'password' && conn.askPasswordAtConnect) return 'password'
  if (conn.auth === 'privateKey' && conn.askPassphraseAtConnect) return 'passphrase'
  return null
}

export interface SessionOpenOptions {
  kind: 'local' | 'ssh'
  /** ssh only */
  connectionId?: string
  secretOverride?: SshSecretOverride
}

export type HostKeyAction = 'accept' | 'reject'

export interface HostKeyPromptEvent {
  promptId: string
  host: string
  port: number
  /** sha256 fingerprint, base64 (no padding), ssh "SHA256:..." style */
  fingerprint: string
  reason: 'new' | 'changed'
}

/** Reuse LayoutMeta shape for layout templates only; groups are a plain string field on SshConnection. */
export type ConnectionMeta = Pick<SshConnection, 'id' | 'name' | 'group'>
export type { LayoutMeta }
