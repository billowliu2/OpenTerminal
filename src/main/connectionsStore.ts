/**
 * SSH connection bookmarks. Persists to <userData>/connections.json as an array.
 *
 * Secret fields (password / keyContent / passphrase) are persisted only
 * encrypted via Electron safeStorage (base64 blob in `*_enc` fields). The
 * renderer contracts (`SshConnection`) never contain a secret: `*_enc` fields
 * are stripped from the returned objects and replaced with `savedAuth` flags.
 *
 * When safeStorage is unavailable (e.g. during headless dev) the plaintext
 * secret is base64'd and prefixed with `plain:` so the record stays
 * serialisable — a dev-only fallback surfaced via console.warn.
 */

import { safeStorage } from 'electron'
import { randomUUID } from 'crypto'
import { copyFileSync, existsSync, readFileSync } from 'fs'
import type { SshAuthMethod, SshConnection, SshConnectionInput } from '../shared/connections'
import { writeJson } from './store'

const ENC_SUFFIX = '_enc'
const PLAIN_PREFIX = 'plain:'
const SECRET_KEYS = ['password', 'keyContent', 'passphrase'] as const
const AUTH_METHODS: ReadonlySet<string> = new Set(['password', 'privateKey', 'agent'])

/**
 * Runtime coercion for renderer-supplied connection fields. saveConnection
 * copies input values verbatim, and they flow straight into ssh2's
 * ConnectConfig (port, keepalive) — a malformed save or a renderer regression
 * must not persist `port: "22"` or a NaN-bound keepalive. Repair over drop,
 * like every other store: strings stay strings, numbers are range-checked,
 * unknown auth falls back to password, optional fields collapse to undefined.
 */
function coerceConnectionInput(input: SshConnectionInput): SshConnectionInput {
  const out = { ...input } as Record<string, unknown>
  out.name = typeof input.name === 'string' ? input.name : ''
  out.group = typeof input.group === 'string' && input.group !== '' ? input.group : undefined
  out.host = typeof input.host === 'string' ? input.host.trim() : ''
  out.username = typeof input.username === 'string' ? input.username : ''
  const port = Number(input.port)
  out.port = Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 22
  out.auth = AUTH_METHODS.has(input.auth as string) ? input.auth : 'password'
  out.askPasswordAtConnect = input.askPasswordAtConnect === true
  out.askPassphraseAtConnect = input.askPassphraseAtConnect === true
  out.keyPath =
    typeof input.keyPath === 'string' && input.keyPath !== '' ? input.keyPath : undefined
  const keepalive = Number(input.keepaliveIntervalSec)
  out.keepaliveIntervalSec =
    Number.isFinite(keepalive) && keepalive >= 0 ? Math.round(keepalive) : 0
  out.highlightProfileId =
    typeof input.highlightProfileId === 'string' && input.highlightProfileId !== ''
      ? input.highlightProfileId
      : undefined
  for (const key of SECRET_KEYS) {
    if (out[key] !== undefined && typeof out[key] !== 'string') out[key] = undefined
  }
  return out as unknown as SshConnectionInput
}

/** Internal persisted record: public fields + encrypted secret fields. */
interface StoredConnection {
  id: string
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
  highlightProfileId?: string
  createdAt: number
  lastConnectedAt?: number
  password_enc?: string
  keyContent_enc?: string
  passphrase_enc?: string
}

/** Public fields of SshConnectionInput reflected onto a StoredConnection. */
const PUBLIC_KEYS = [
  'name',
  'group',
  'host',
  'port',
  'username',
  'auth',
  'askPasswordAtConnect',
  'askPassphraseAtConnect',
  'keyPath',
  'keepaliveIntervalSec',
  'highlightProfileId'
] as const satisfies readonly (keyof Omit<StoredConnection, 'password_enc' | 'keyContent_enc' | 'passphrase_enc'>)[]

function encrypt(plain: string): string {
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(plain).toString('base64')
  }
  // Dev fallback: no OS keychain, store a reversible base64 marker so the
  // field still round-trips through JSON.
  console.warn(
    '[connections] safeStorage unavailable - storing plain: prefixed base64 secret (dev only)'
  )
  return PLAIN_PREFIX + Buffer.from(plain, 'utf8').toString('base64')
}

function decrypt(stored: string | undefined): string | undefined {
  if (typeof stored !== 'string' || stored.length === 0) return undefined
  if (stored.startsWith(PLAIN_PREFIX)) {
    return Buffer.from(stored.slice(PLAIN_PREFIX.length), 'base64').toString('utf8')
  }
  if (safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(stored, 'base64'))
    } catch {
      return undefined
    }
  }
  return undefined
}

/** Strip secret fields from an internal record into the renderer contract. */
function toPublic(stored: StoredConnection): SshConnection {
  return {
    id: stored.id,
    name: stored.name,
    group: stored.group,
    host: stored.host,
    port: stored.port,
    username: stored.username,
    auth: stored.auth,
    askPasswordAtConnect: stored.askPasswordAtConnect,
    askPassphraseAtConnect: stored.askPassphraseAtConnect,
    keyPath: stored.keyPath,
    keepaliveIntervalSec: stored.keepaliveIntervalSec,
    highlightProfileId: stored.highlightProfileId,
    createdAt: stored.createdAt,
    lastConnectedAt: stored.lastConnectedAt,
    savedAuth: {
      hasPassword: stored.password_enc !== undefined && stored.password_enc.length > 0,
      hasKeyContent: stored.keyContent_enc !== undefined && stored.keyContent_enc.length > 0,
      hasPassphrase: stored.passphrase_enc !== undefined && stored.passphrase_enc.length > 0
    }
  }
}

/**
 * A connections.json that exists but cannot be read or parsed must never be
 * silently destroyed: load() falls back to an empty list, and the next write
 * (any bookmark edit, or just a `touch()` after connecting) would rewrite the
 * file from that empty list — taking every saved host and its `*_enc`
 * credentials with it. Keep a one-time copy the user can recover from before
 * that can happen.
 */
function backupUnparseableConnections(file: string, err: unknown): void {
  try {
    // ENOENT (first run) is the normal empty case: nothing to lose, stay quiet.
    if (!existsSync(file)) return
    const bak = `${file}.bak`
    if (existsSync(bak)) return // keep the first backup; later loads must not clobber it
    copyFileSync(file, bak)
    console.warn(
      `[connections] ${file} unparseable (${err instanceof Error ? err.message : String(err)}) — original kept at ${bak}`
    )
  } catch {
    // best effort: the backup must never break loading
  }
}

export class ConnectionsStore {
  constructor(private readonly filePath: string) {}

  private load(): StoredConnection[] {
    try {
      const raw: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'))
      if (Array.isArray(raw)) {
        return raw.filter(
          (x): x is StoredConnection =>
            x !== null &&
            typeof x === 'object' &&
            typeof (x as StoredConnection).id === 'string' &&
            typeof (x as StoredConnection).host === 'string'
        )
      }
    } catch (err) {
      // missing -> start fresh; unreadable / corrupt -> keep the original first
      backupUnparseableConnections(this.filePath, err)
    }
    return []
  }

  private save(list: StoredConnection[]): void {
    writeJson(this.filePath, list)
  }

  listConnections(): SshConnection[] {
    return this.load().map(toPublic)
  }

  /** Decrypt a stored secret for a connection (undefined when absent). */

  /** Decrypt a stored secret for a connection (undefined when absent). */
  getSecret(
    conn: SshConnection,
    field: 'password' | 'keyContent' | 'passphrase'
  ): string | undefined {
    const encField = `${field}${ENC_SUFFIX}` as keyof StoredConnection
    const stored = this.load().find((c) => c.id === conn.id)
    return stored ? decrypt(stored[encField] as string | undefined) : undefined
  }

  saveConnection(rawInput: SshConnectionInput): SshConnection {
    const input = coerceConnectionInput(rawInput)
    const list = this.load()
    let stored: StoredConnection | undefined

    if (typeof input.id === 'string' && input.id.length > 0) {
      stored = list.find((c) => c.id === input.id)
    }

    if (stored) {
      // Update in place; omitted secrets keep their previously stored value.
      const target = stored as unknown as Record<string, unknown>
      const source = input as unknown as Record<string, unknown>
      for (const key of PUBLIC_KEYS) {
        target[key] = source[key]
      }
    } else {
      stored = {
        id: input.id && input.id.length > 0 ? input.id : randomUUID(),
        name: input.name,
        group: input.group,
        host: input.host,
        port: input.port,
        username: input.username,
        auth: input.auth,
        askPasswordAtConnect: input.askPasswordAtConnect,
        askPassphraseAtConnect: input.askPassphraseAtConnect,
        keyPath: input.keyPath,
        keepaliveIntervalSec: input.keepaliveIntervalSec,
        highlightProfileId: input.highlightProfileId,
        createdAt: Date.now()
      }
      list.push(stored)
    }

    // Encrypt new secret values; absent secrets leave the previous value intact.
    const target = stored as unknown as Record<string, unknown>
    for (const key of SECRET_KEYS) {
      const value = input[key]
      if (value === undefined) continue
      if (value === '') {
        delete target[`${key}${ENC_SUFFIX}`]
      } else {
        target[`${key}${ENC_SUFFIX}`] = encrypt(value)
      }
    }

    this.save(list)
    return toPublic(stored)
  }

  deleteConnection(id: string): void {
    const list = this.load()
    const next = list.filter((c) => c.id !== id)
    if (next.length < list.length) this.save(next)
  }

  /** Mark a connection as recently used. */
  touch(id: string, at = Date.now()): void {
    const list = this.load()
    const conn = list.find((c) => c.id === id)
    if (!conn) return
    conn.lastConnectedAt = at
    this.save(list)
  }
}

/** Default location: <userData>/connections.json */
export function defaultConnectionsPath(userDataPath: string): string {
  return `${userDataPath}/connections.json`
}