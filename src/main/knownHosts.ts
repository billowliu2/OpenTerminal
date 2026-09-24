/**
 * Host key pinning store. Persists to <userData>/ssh_known_hosts.json.
 * No Electron imports here: the file location is injected so the module can be
 * reused by the loopback test harness (and any future main-process unit tests).
 */

import { createHash, randomUUID } from 'crypto'
import { readFileSync } from 'fs'
import { writeJson } from './store'

export interface KnownHostEntry {
  /** uuid; addedAt is split out so fingerprint clash updates can be precise */
  id: string
  host: string
  port: number
  /** raw ssh wire-format host key (base64, no padding) */
  keyBase64: string
  /** 'SHA256:' + base64(sha256(key)) without padding, OpenSSH style */
  fingerprint: string
  addedAt: number
}

export interface KnownHostsStoreShape {
  version: 1
  entries: KnownHostEntry[]
}

export type HostKeyCheckResult =
  | { status: 'match'; entry: KnownHostEntry }
  | { status: 'new' }
  | { status: 'changed'; stored: KnownHostEntry }
  /**
   * The store file exists but cannot be trusted (unreadable, corrupt JSON or
   * not the expected shape). Callers must fail closed: accepting here would
   * rewrite the store from an empty table and destroy every pinned fingerprint.
   */
  | { status: 'unreadable' }

/**
 * Load outcome, so "the file was never written" (TOFU from scratch) stays
 * distinguishable from "the file is there but we cannot read it" (data loss
 * in progress — never pretend the store is empty).
 */
type LoadResult =
  | { kind: 'ok'; shape: KnownHostsStoreShape }
  | { kind: 'missing' }
  | { kind: 'unreadable' }

/** sha256 fingerprint in ssh "SHA256:..." style (no padding) */
export function fingerprintOf(key: Buffer): string {
  return 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
}

export class KnownHostsStore {
  constructor(private readonly filePath: string) {}

  private load(): LoadResult {
    let raw: string
    try {
      raw = readFileSync(this.filePath, 'utf8')
    } catch (err) {
      // A file that was never created is the normal first-connect case; any
      // other read failure (EACCES, EISDIR, ...) means data we cannot see.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' }
      return { kind: 'unreadable' }
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      if (parsed !== null && typeof parsed === 'object') {
        const shape = parsed as Partial<KnownHostsStoreShape>
        if (Array.isArray(shape.entries)) {
          return {
            kind: 'ok',
            shape: {
              version: 1,
              entries: shape.entries.filter(
                (e): e is KnownHostEntry =>
                  e !== null &&
                  typeof e === 'object' &&
                  typeof (e as KnownHostEntry).host === 'string' &&
                  typeof (e as KnownHostEntry).keyBase64 === 'string'
              )
            }
          }
        }
      }
    } catch {
      // fall through: JSON.parse failure
    }
    // Parses-but-wrong-shape is treated like corrupt: a file at this path that
    // is not the store we wrote is not evidence that nothing was pinned.
    return { kind: 'unreadable' }
  }

  private save(shape: KnownHostsStoreShape): void {
    writeJson(this.filePath, shape)
  }

  /**
   * Compare the live host key against the stored entry for (host, port).
   * Returns `unreadable` when the store exists but cannot be read — never a
   * `new` verdict, which would invite overwriting the pin data on accept.
   */
  check(host: string, port: number, key: Buffer): HostKeyCheckResult {
    const loaded = this.load()
    if (loaded.kind === 'unreadable') return { status: 'unreadable' }
    // A file that was never written is the genuine TOFU case; an unreadable
    // one was already handled above and must never degrade to 'new'.
    const entries =
      loaded.kind === 'ok'
        ? loaded.shape.entries.filter((e) => e.host === host && e.port === port)
        : []
    if (entries.length === 0) return { status: 'new' }

    const fingerprint = fingerprintOf(key)
    const keyBase64 = key.toString('base64')
    const stored = entries[0]
    if (stored.keyBase64 === keyBase64 || stored.fingerprint === fingerprint) {
      return { status: 'match', entry: stored }
    }
    return { status: 'changed', stored }
  }

  /**
   * Record a new host key (accept of a 'new' or 'changed' prompt).
   *
   * Throws when the store is currently unreadable: rewriting the file from a
   * table we failed to load would wipe every other pinned fingerprint.
   */
  accept(host: string, port: number, key: Buffer, fingerprint: string): KnownHostEntry {
    const loaded = this.load()
    if (loaded.kind === 'unreadable') {
      throw new Error(`known hosts store unreadable, refusing to overwrite: ${this.filePath}`)
    }
    const shape: KnownHostsStoreShape =
      loaded.kind === 'ok' ? loaded.shape : { version: 1, entries: [] }
    const entry: KnownHostEntry = {
      id: randomUUID(),
      host,
      port,
      keyBase64: key.toString('base64'),
      fingerprint,
      addedAt: Date.now()
    }
    shape.entries = shape.entries.filter((e) => !(e.host === host && e.port === port))
    shape.entries.push(entry)
    this.save(shape)
    return entry
  }

  /** Empty when the store is unreadable: callers must not treat that as "no pins". */
  list(): KnownHostEntry[] {
    const loaded = this.load()
    return loaded.kind === 'ok' ? [...loaded.shape.entries] : []
  }
}

/** Default location: <userData>/ssh_known_hosts.json */
export function defaultKnownHostsPath(userDataPath: string): string {
  return `${userDataPath}/ssh_known_hosts.json`
}