/**
 * Screen-lock stores. The verifier persists to <userData>/lock.json, the live
 * lock flags (locked / failures / cooldownUntil) to <userData>/lock-state.json.
 *
 * No Electron imports here: both file locations are injected, the same way the
 * known-hosts store does it, so the module can be driven by a plain-Node test.
 *
 * What lands on disk is a scrypt verifier, never the password: a random 16-byte
 * salt plus scrypt(password, salt, 64), both base64. The comparison goes through
 * timingSafeEqual so a wrong password cannot be narrowed down by response time,
 * and the password is never logged, echoed back or put in an error message.
 *
 * A missing, truncated, wrong-shaped or wrongly-sized verifier file reads as
 * "not configured": losing the lock is a nuisance, while throwing out of a
 * startup path would make the app unstartable. The state store is just as
 * forgiving, for the same reason.
 */

import { randomBytes, scrypt, timingSafeEqual } from 'crypto'
import { unlinkSync } from 'fs'
import { readJson, writeJson } from './store'

/** Shape written to disk; `version` gates any future migration. */
export interface LockStoreShape {
  version: 1
  /** random per-install salt, base64 */
  salt: string
  /** scrypt(password, salt, KEY_LENGTH), base64 */
  hash: string
  createdAt: number
}

const SALT_BYTES = 16
const KEY_LENGTH = 64

/**
 * scrypt cost parameters, spelled out rather than left to node's defaults so the
 * verifier cannot be silently re-tuned by a runtime upgrade (an existing hash
 * has to stay checkable).
 */
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }

export const MIN_PASSWORD_LENGTH = 4
export const MAX_PASSWORD_LENGTH = 128

/** An empty or absurdly long password is refused rather than hashed. */
export function isValidPassword(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= MIN_PASSWORD_LENGTH &&
    value.length <= MAX_PASSWORD_LENGTH
  )
}

/** Async on purpose: scryptSync would block the main process (which streams PTY
 *  output) for ~100ms on every attempt. */
function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, SCRYPT_OPTIONS, (err, key) => {
      if (err) reject(err)
      else resolve(key)
    })
  })
}

export class LockStore {
  constructor(private readonly filePath: string) {}

  /** The load path runs on every state query, so the unknown-version warning
   *  must fire once per process rather than once per call. */
  private static warnedUnknownVersion = false

  /** The stored verifier, or null when unconfigured or unusable. */
  private load(): LockStoreShape | null {
    const parsed = readJson<Partial<LockStoreShape>>(this.filePath)
    if (parsed === null || typeof parsed !== 'object') return null
    if (parsed.version !== 1) {
      // Fail-open is deliberate (a lock file nobody can read must not make the
      // app unstartable), but a future format must not disable the lock
      // silently: the file exists, says it holds a verifier, and is being
      // ignored. One warning per process; the message quotes nothing from it.
      if (!LockStore.warnedUnknownVersion) {
        LockStore.warnedUnknownVersion = true
        console.warn(
          '[lock] lock.json has a version this build does not know; reading it as not configured — the password must be set again'
        )
      }
      return null
    }
    if (typeof parsed.salt !== 'string' || typeof parsed.hash !== 'string') return null
    if (typeof parsed.createdAt !== 'number') return null
    const salt = Buffer.from(parsed.salt, 'base64')
    const hash = Buffer.from(parsed.hash, 'base64')
    // A verifier of the wrong size is a corrupt file, not a weak password: it
    // can never match, so it must not count as "a password is set".
    if (salt.length !== SALT_BYTES || hash.length !== KEY_LENGTH) return null
    return { version: 1, salt: parsed.salt, hash: parsed.hash, createdAt: parsed.createdAt }
  }

  isConfigured(): boolean {
    return this.load() !== null
  }

  /**
   * Write a fresh verifier — first set and replace alike, because the salt is
   * regenerated so the previous hash (and anyone who saw it) becomes worthless.
   * Throws on an unusable password; the caller maps that to `invalid-password`.
   */
  async setPassword(password: string): Promise<void> {
    if (!isValidPassword(password)) {
      throw new Error(
        `lock password must be ${MIN_PASSWORD_LENGTH}..${MAX_PASSWORD_LENGTH} characters`
      )
    }
    const salt = randomBytes(SALT_BYTES)
    const hash = await derive(password, salt)
    const shape: LockStoreShape = {
      version: 1,
      salt: salt.toString('base64'),
      hash: hash.toString('base64'),
      createdAt: Date.now()
    }
    writeJson(this.filePath, shape)
  }

  /** Constant-time check. False when unconfigured; never throws. */
  async verify(password: string): Promise<boolean> {
    const stored = this.load()
    if (stored === null || typeof password !== 'string') return false
    const expected = Buffer.from(stored.hash, 'base64')
    const actual = await derive(password, Buffer.from(stored.salt, 'base64'))
    // Lengths are equal by construction (load() enforces it); the guard keeps
    // timingSafeEqual from throwing on a file that changed underneath us.
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  }

  /** Forget the password: the file is deleted, so "not configured" is one state
   *  rather than two (an empty file vs. no file). */
  clear(): void {
    try {
      unlinkSync(this.filePath)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }
}

/** Default location: <userData>/lock.json */
export function defaultLockPath(userDataPath: string): string {
  return `${userDataPath}/lock.json`
}

/** The live lock flags, as persisted and as held in memory by the controller. */
export interface LockState {
  locked: boolean
  failures: number
  cooldownUntil: number
}

/** Shape written to disk; `version` gates any future migration. */
interface LockStateShape extends LockState {
  version: 1
}

/**
 * Persistence for the lock flags themselves, so quitting and relaunching is not
 * a way out of a lock that was already up (nor a way to reset the backoff that
 * was already earned). Only flags live here — never a password, never a hash.
 *
 * Like the verifier store, this reads a missing/corrupt/wrong-shaped file as
 * "nothing was ever locked": the load happens on the startup path, where
 * throwing would leave the app without a window but still holding the
 * single-instance lock.
 */
export class LockStateStore {
  constructor(private readonly filePath: string) {}

  /** The stored flags, or "unlocked with no failures" for anything unusable. */
  load(): LockState {
    const fallback: LockState = { locked: false, failures: 0, cooldownUntil: 0 }
    const parsed = readJson<Partial<LockStateShape>>(this.filePath)
    if (parsed === null || typeof parsed !== 'object') return fallback
    if (parsed.version !== 1) return fallback
    const { failures, cooldownUntil } = parsed
    return {
      locked: parsed.locked === true,
      failures:
        typeof failures === 'number' && Number.isInteger(failures) && failures > 0 ? failures : 0,
      cooldownUntil:
        typeof cooldownUntil === 'number' && Number.isFinite(cooldownUntil) && cooldownUntil > 0
          ? cooldownUntil
          : 0
    }
  }

  /** Atomic write (temp file + rename), so a crash mid-write cannot leave a
   *  half-written file that would read back as "never locked". */
  save(state: LockState): void {
    const shape: LockStateShape = { version: 1, ...state }
    writeJson(this.filePath, shape)
  }

  /** Forget the flags: the file is deleted, so "not locked" is one state rather
   *  than two (an empty file vs. no file). */
  clear(): void {
    try {
      unlinkSync(this.filePath)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }
}

/** Default location: <userData>/lock-state.json */
export function defaultLockStatePath(userDataPath: string): string {
  return `${userDataPath}/lock-state.json`
}
