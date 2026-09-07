/**
 * Host key pinning store. Persists to <userData>/ssh_known_hosts.json.
 * No Electron imports here: the file location is injected so the module can be
 * reused by the loopback test harness (and any future main-process unit tests).
 */

import { createHash, randomUUID } from 'crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname } from 'path'

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

/** sha256 fingerprint in ssh "SHA256:..." style (no padding) */
export function fingerprintOf(key: Buffer): string {
  return 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
}

export class KnownHostsStore {
  constructor(private readonly filePath: string) {}

  private load(): KnownHostsStoreShape {
    try {
      const raw: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'))
      if (raw !== null && typeof raw === 'object') {
        const shape = raw as Partial<KnownHostsStoreShape>
        if (Array.isArray(shape.entries)) {
          return {
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
    } catch {
      // missing / corrupted file -> start fresh
    }
    return { version: 1, entries: [] }
  }

  private save(shape: KnownHostsStoreShape): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    writeFileSync(this.filePath, JSON.stringify(shape, null, 2), 'utf8')
  }

  /**
   * Compare the live host key against the stored entry for (host, port).
   */
  check(host: string, port: number, key: Buffer): HostKeyCheckResult {
    const entries = this.load().entries.filter((e) => e.host === host && e.port === port)
    if (entries.length === 0) return { status: 'new' }

    const fingerprint = fingerprintOf(key)
    const keyBase64 = key.toString('base64')
    const stored = entries[0]
    if (stored.keyBase64 === keyBase64 || stored.fingerprint === fingerprint) {
      return { status: 'match', entry: stored }
    }
    return { status: 'changed', stored }
  }

  /** Record a new host key (accept of a 'new' or 'changed' prompt). */
  accept(host: string, port: number, key: Buffer, fingerprint: string): KnownHostEntry {
    const shape = this.load()
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

  list(): KnownHostEntry[] {
    return [...this.load().entries]
  }
}

/** Default location: <userData>/ssh_known_hosts.json */
export function defaultKnownHostsPath(userDataPath: string): string {
  return `${userDataPath}/ssh_known_hosts.json`
}