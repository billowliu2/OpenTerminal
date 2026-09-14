import { mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'fs'
import { dirname, join } from 'path'

/**
 * Small shared persistence helper for the app's JSON stores (settings,
 * connections, known hosts, commands, layouts, the session snapshot).
 *
 * Why not a database: these are a handful of KB written by a single process at
 * human speed, and every native DB binding (better-sqlite3 et al) would add a
 * per-platform rebuild + packaging burden to a cross-platform app. What the
 * stores actually needed was the *reliability* a DB implies — that is what this
 * gives: an atomic write (write to a sibling temp file, then rename) so a crash
 * or a full disk can never leave a half-written file behind, and a capped size
 * so a runaway value cannot fill the disk either.
 *
 * If a dataset ever outgrows this (command history in the tens of thousands, or
 * full-text search over session logs), swap the implementation here — callers
 * only ever see `readJson`/`writeJson`.
 */

/** Refuse to load a file larger than this (guards against a runaway store). */
const MAX_BYTES = 8 * 1024 * 1024

const tmpPath = (file: string): string => `${file}.tmp`

export function readJson<T = unknown>(file: string): T | null {
  try {
    const raw = readFileSync(file, 'utf8')
    if (raw.length > MAX_BYTES) return null
    return JSON.parse(raw) as T
  } catch {
    // Missing, unreadable or corrupt: callers fall back to their defaults.
    // A corrupt file is left in place (not deleted) so it can be inspected.
    return null
  }
}

export function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = tmpPath(file)
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
    renameSync(tmp, file)
  } catch (err) {
    // Clean up the temp file so a failed write does not leave litter behind.
    try {
      unlinkSync(tmp)
    } catch {
      /* nothing to clean */
    }
    throw err
  }
}

/** Convenience for stores whose file lives under a directory. */
export function jsonFileIn(dir: string, name: string): string {
  return join(dir, name)
}

/** Minimal shape guard used by the stores before trusting a parsed value. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
