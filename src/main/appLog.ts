/**
 * Diagnostic app log (appLog.ts).
 *
 * The "app froze, then recovered" watchdogs (`[main]` / `[renderer] stalled`)
 * used to reach only the console, which a packaged build never shows — field
 * reports came back with no evidence attached. This module persists them:
 * daily files `app-YYYY-MM-DD.log` under `<userData>/logs`, appended
 * asynchronously off the event loop's critical path, one event per line.
 *
 * Retention: files older than APP_LOG_RETENTION_DAYS are deleted at startup
 * and once a day afterwards (a long-running process crosses midnights). Only
 * names matching the app log pattern are touched — foreign files in the
 * directory are left alone. Session recordings (LOG_START) are user files
 * and never come near this mechanism.
 *
 * The pure naming/retention helpers are table-tested by tests/app-log.mjs
 * through the bundled build (tests/.app-log.cjs).
 */
import { app } from 'electron'
import { appendFile, mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

export const APP_LOG_RETENTION_DAYS = 7

const NAME_RE = /^app-(\d{4})-(\d{2})-(\d{2})\.log$/
const DAY_MS = 24 * 60 * 60 * 1000
/** One event is one line; runaway payloads are truncated, not trusted. */
const MAX_LINE = 2000

const pad = (n: number, w = 2): string => String(n).padStart(w, '0')

/** `app-YYYY-MM-DD.log`, on the LOCAL date — users read these by hand. */
export function appLogName(date: Date): string {
  return `app-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.log`
}

/** Local midnight (ms) encoded in an app log file name, or null for foreign names. */
export function parseAppLogName(name: string): number | null {
  const m = NAME_RE.exec(name)
  if (!m) return null
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime()
}

/**
 * A log file expires when its day STARTS more than `retentionDays` before
 * today's start: today plus the previous N days are kept, anything older
 * goes. Foreign names are never expired.
 */
export function isExpiredAppLog(name: string, now: Date, retentionDays = APP_LOG_RETENTION_DAYS): boolean {
  const day = parseAppLogName(name)
  if (day === null) return false
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  return day < today - retentionDays * DAY_MS
}

let logDir: string | null = null
let queue: Promise<unknown> = Promise.resolve()
// The settings gate (settings.system.diagnosticLog, default on). Off = appLog
// records nothing; the retention sweep still runs, it only deletes.
let enabled = true

/** Follow `settings.system.diagnosticLog`; called on every settings mutation. */
export function setAppLogEnabled(on: boolean): void {
  enabled = on
}

function enqueue(task: () => Promise<unknown>): Promise<void> {
  // Serialize appends, and never let a logging failure escape into the app.
  const next = queue.then(task).then(
    (): void => undefined,
    (): void => undefined
  )
  queue = next
  return next
}

/**
 * Point the log at `<userData>/logs` (or `dir` in tests), sweep expired
 * files, and re-sweep once a day so a process that never restarts still
 * cleans up. The daily timer is unref'd like every other timer in main.
 */
export function initAppLog(dir?: string): void {
  const target = dir ?? join(app.getPath('userData'), 'logs')
  logDir = target
  void enqueue(async () => {
    await mkdir(target, { recursive: true })
    await sweepAppLogs(target)
  })
  setInterval(() => {
    void sweepAppLogs(target).catch(() => undefined)
  }, DAY_MS).unref()
}

/** Remove expired log files under `dir`; returns the removed names. */
export async function sweepAppLogs(
  dir: string,
  now = new Date(),
  retentionDays = APP_LOG_RETENTION_DAYS
): Promise<string[]> {
  const entries = await readdir(dir)
  const doomed = entries.filter((n) => isExpiredAppLog(n, now, retentionDays))
  await Promise.all(doomed.map((n) => rm(join(dir, n), { force: true })))
  return doomed
}

const stamp = (d: Date): string =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
  `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`

/**
 * Append one event line. Fire-and-forget for callers, but the returned
 * promise settles once the line is on disk (tests drain on it). Before
 * initAppLog — or with the setting gate off — the line is dropped, same as
 * the console-only past. The source column is padded so stacked lines align.
 */
export function appLog(source: 'main' | 'renderer', line: string): Promise<void> {
  if (!logDir || !enabled) return Promise.resolve()
  const dir = logDir
  const text = `[${stamp(new Date())}] [${source.padEnd(8)}] ${String(line).replace(/[\r\n]+/g, ' ').slice(0, MAX_LINE)}\n`
  return enqueue(() => appendFile(join(dir, appLogName(new Date())), text, 'utf8'))
}
