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
