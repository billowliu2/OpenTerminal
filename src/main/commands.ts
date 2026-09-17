/**
 * Command history / command library + session output logs (M5).
 *
 * Persistence mirrors the connections store: plain JSON files under
 * <userData>/ without sqlite. Two concerns live here:
 *
 *  - Commands: <userData>/commands.json as `{ history, library }`.
 *    History is capped, deduped against the newest entry and sorted by
 *    lastUsedAt; library items are sorted by createdAt and support id-based
 *    update-or-create.
 *  - Session logs: <userData>/logs/<YYYYMMDD-HHmmss>-<id8>.log plain-text
 *    files plus an index file (<userData>/logs/index.json) of SessionLogMeta
 *    that survives restart. PTY data is pushed in by the session layer via the
 *    registered data logger; streams stop on session close.
 *
 * The only Electron binding is `app.getPath` (data dir) and `shell.openPath`
 * (open the logs folder). Both are injectable so this module can be bundled
 * and tested under plain Node.
 */

import { app, shell } from 'electron'
import { randomUUID } from 'crypto'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { appendFile } from 'fs/promises'
import { join } from 'path'
import type { CommandItem, SessionLogMeta } from '../shared/commands'
import { DEFAULT_SETTINGS } from '../shared/settings'
import { loadSettings } from './settingsStore'
import { LogSanitizer } from './logSanitizer'

/** Upper bound on recorded history entries when no limit is configured. */
const HISTORY_CAP = 500
/** Hard ceiling: the history is also the completion source, so it stays small. */
export const HISTORY_LIMIT_MAX = 500

interface CommandsFile {
  history: CommandItem[]
  library: CommandItem[]
}

function emptyFile(): CommandsFile {
  return { history: [], library: [] }
}

/** Default data root: <userData> (computed by the store itself). */
export function defaultCommandsPath(userDataPath: string): string {
  return userDataPath
}

function two(n: number): string {
  return String(n).padStart(2, '0')
}

/** YYYYMMDD-HHmmss timestamp used in log file names. */
function stamp(d = new Date()): string {
  return (
    `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}` +
    `-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`
  )
}

export class CommandsStore {
  /** <userData>/commands.json */
  private readonly file: string
  /** <userData>/logs */
  private readonly logsDir: string
  /** <userData>/logs/index.json */
  private readonly indexFile: string
  private readonly openPathImpl?: (p: string) => Promise<unknown>

  /** All known logs keyed by absolute file path (hydrated from index on boot). */
  private readonly metasByFile = new Map<string, SessionLogMeta>()
  /** Logs currently accumulating output, keyed by sessionId. */
  private readonly activeBySession = new Map<string, SessionLogMeta>()
  /**
   * Buffered plain text per log file, flushed by a single drain loop per file.
   * Writes land in the buffer synchronously (so order is preserved) and the
   * drain merges everything that accumulated during the previous appendFile
   * round trip into one append call — burst output costs one syscall per IO
   * tick instead of one Promise chain link per logWrite.
   */
  private readonly logBuffers = new Map<string, string>()
  /** In-flight drain loop per log file; absent when the file is settled. */
  private readonly logDrains = new Map<string, Promise<void>>()
  /** Plain-text transformer per actively-logged session (see logSanitizer). */
  private readonly sanitizers = new Map<string, LogSanitizer>()

  constructor(userData?: string, openPathImpl?: (p: string) => Promise<unknown>) {
    const ud = userData ?? app.getPath('userData')
    this.file = join(ud, 'commands.json')
    this.logsDir = join(ud, 'logs')
    this.indexFile = join(this.logsDir, 'index.json')
    this.openPathImpl = openPathImpl
    this.hydrateIndex()
  }

  // ---- commands file (history + library) -----------------------------------

  private loadCommands(): CommandsFile {
    try {
      const raw: unknown = JSON.parse(readFileSync(this.file, 'utf8'))
      if (raw && typeof raw === 'object' && Array.isArray((raw as CommandsFile).history)) {
        const data = raw as CommandsFile
        return {
          history: Array.isArray(data.history) ? data.history : [],
          library: Array.isArray(data.library) ? data.library : []
        }
      }
    } catch {
      // missing / corrupted file -> start fresh
    }
    return emptyFile()
  }

  private saveCommands(data: CommandsFile): void {
    mkdirSync(join(this.file, '..'), { recursive: true })
    writeFileSync(this.file, JSON.stringify(data, null, 2), 'utf8')
  }

  /**
   * Record one executed command.
   *
   * Deduplication is over the *whole* history, not just the newest entry: a
   * command used three commands ago is the same command, so re-running it moves
   * the existing entry to the front (refreshing `lastUsedAt`) instead of adding
   * a second copy. History reads back sorted by `lastUsedAt`, so hoisting is
   * exactly what "most recently used" means — and it keeps the list from
   * filling up with one line repeated.
   *
   * Silently does nothing when 设置 → 终端 → 记录命令历史 is off: the setting is
   * read here (not at the call site) so every recording path honours it, and
   * existing history is left untouched rather than cleared.
   */
  recordCommand(cmd: string): void {
    const trimmed = cmd.trim()
    if (!trimmed) return
    const { historyEnabled, historyLimit } = loadHistoryPrefs()
    if (!historyEnabled) return
    const cap = normalizeLimit(historyLimit)
    const data = this.loadCommands()
    const existing = data.history.findIndex((item) => item.command === trimmed)
    if (existing >= 0) {
      const [item] = data.history.splice(existing, 1)
      item.lastUsedAt = Date.now()
      data.history.unshift(item)
    } else {
      data.history.unshift({
        id: randomUUID(),
        command: trimmed,
        createdAt: Date.now(),
        lastUsedAt: Date.now()
      })
    }
    if (data.history.length > cap) data.history.length = cap
    this.saveCommands(data)
  }

  /**
   * History sorted by most recently used, trimmed to the configured limit.
   *
   * The trim happens on read as well as on write so lowering the limit in
   * settings takes effect at once instead of waiting for the next command.
   */
  listHistory(): CommandItem[] {
    const { historyLimit } = loadHistoryPrefs()
    return this.loadCommands()
      .history.slice()
      .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
      .slice(0, normalizeLimit(historyLimit))
  }

  clearHistory(): void {
    const data = this.loadCommands()
    data.history = []
    this.saveCommands(data)
  }

  /** Library sorted newest first. */
  listLibrary(): CommandItem[] {
    return this.loadCommands()
      .library.slice()
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  /** Insert (no id) or update (has id); returns the stored entry. */
  saveLibraryItem(item: CommandItem): CommandItem {
    const data = this.loadCommands()
    let stored: CommandItem | undefined
    if (typeof item.id === 'string' && item.id.length > 0) {
      stored = data.library.find((x) => x.id === item.id)
    }
    if (stored) {
      stored.name = item.name
      stored.command = item.command
      stored.note = item.note
      stored.group = item.group
      stored.params = item.params
    } else {
      stored = {
        id: item.id && item.id.length > 0 ? item.id : randomUUID(),
        name: item.name,
        command: item.command,
        note: item.note,
        group: item.group,
        params: item.params,
        createdAt: Date.now()
      }
      data.library.push(stored)
    }
    this.saveCommands(data)
    return stored
  }

  deleteLibraryItem(id: string): void {
    const data = this.loadCommands()
    const next = data.library.filter((x) => x.id !== id)
    if (next.length < data.library.length) {
      data.library = next
      this.saveCommands(data)
    }
  }

  // ---- session logs -----------------------------------------------------------

  private hydrateIndex(): void {
    try {
      if (!existsSync(this.indexFile)) return
      const raw: unknown = JSON.parse(readFileSync(this.indexFile, 'utf8'))
      if (!Array.isArray(raw)) return
      for (const x of raw) {
        if (
          x &&
          typeof (x as SessionLogMeta).sessionId === 'string' &&
          typeof (x as SessionLogMeta).file === 'string'
        ) {
          const meta = x as SessionLogMeta
          this.metasByFile.set(meta.file, meta)
          if (meta.endedAt === undefined) this.activeBySession.set(meta.sessionId, meta)
        }
      }
    } catch {
      // index missing / corrupt -> rebuild on next write
    }
  }

  /** Write the full log index so listSessionLogs survives restart. */
  private persistIndex(): void {
    try {
      mkdirSync(this.logsDir, { recursive: true })
      const all = Array.from(this.metasByFile.values()).sort(
        (a, b) => b.startedAt - a.startedAt
      )
      writeFileSync(this.indexFile, JSON.stringify(all, null, 2), 'utf8')
    } catch {
      // best effort: never break the session over an index write failure
    }
  }

  /** Finalize a log (set endedAt, drop from active, persist index). */
  private finishLog(meta: SessionLogMeta): void {
    meta.endedAt = Date.now()
    this.activeBySession.delete(meta.sessionId)
    this.persistIndex()
  }

  /** Start logging a session; any prior active log for the id is stopped first. */
  logStart(sessionId: string): SessionLogMeta {
    const prev = this.activeBySession.get(sessionId)
    if (prev) this.finishLog(prev)

    mkdirSync(this.logsDir, { recursive: true })
    const fileName = `${stamp()}-${sessionId.slice(0, 8)}.log`
    const file = join(this.logsDir, fileName)
    // Create the file eagerly so the first async append cannot race a missing fd.
    describeFile(file)
    const meta: SessionLogMeta = { sessionId, file, fileName, startedAt: Date.now() }
    this.metasByFile.set(file, meta)
    this.activeBySession.set(sessionId, meta)
    this.sanitizers.set(sessionId, new LogSanitizer())
    this.persistIndex()
    return meta
  }

  /** Append output for an active session. No-op when not logging (post-stop safe). */
  logWrite(sessionId: string, data: string): void {
    const meta = this.activeBySession.get(sessionId)
    if (!meta) {
      // not logging (or already stopped) -> ignore, prevents stop/append race
      return
    }
    // Raw PTY output is escape-sequence soup in a text file; log plain text.
    const clean = this.sanitizers.get(sessionId)?.push(data) ?? ''
    if (!clean) return
    this.logBuffers.set(meta.file, (this.logBuffers.get(meta.file) ?? '') + clean)
    this.drainLog(meta.file)
  }

  /**
   * Flush a log file's buffer, keeping at most one drain (and therefore one
   * in-flight appendFile) per file. New writes that arrive mid-flush re-enter
   * the buffer and are picked up by the next loop iteration, merged.
   */
  private drainLog(file: string): Promise<void> {
    const existing = this.logDrains.get(file)
    if (existing) return existing
    const run = (async (): Promise<void> => {
      for (;;) {
        const chunk = this.logBuffers.get(file)
        if (chunk === undefined) break
        this.logBuffers.delete(file)
        try {
          await appendFile(file, chunk, 'utf8')
        } catch {
          // file may have been removed after stop -> ignore
        }
      }
    })()
    run.finally(() => {
      if (this.logDrains.get(file) === run) this.logDrains.delete(file)
    })
    this.logDrains.set(file, run)
    return run
  }

  /** Stop logging a session, stamping endedAt into the registry + index. */
  logStop(sessionId: string): void {
    const meta = this.activeBySession.get(sessionId)
    if (!meta) return
    const tail = this.sanitizers.get(sessionId)?.flush() ?? ''
    this.sanitizers.delete(sessionId)
    if (tail) {
      // Best effort: the trailing partial line belongs in the file too.
      this.logBuffers.set(meta.file, (this.logBuffers.get(meta.file) ?? '') + tail)
      this.drainLog(meta.file)
    }
    this.finishLog(meta)
  }

  /** All known session logs (including persisted ones), newest first. */
  listSessionLogs(): SessionLogMeta[] {
    return Array.from(this.metasByFile.values()).sort((a, b) => b.startedAt - a.startedAt)
  }

  /** Reveal the logs directory in the OS file manager. */
  openLogsDir(): void {
    try {
      mkdirSync(this.logsDir, { recursive: true })
      if (this.openPathImpl) {
        void this.openPathImpl(this.logsDir)
      } else {
        void shell.openPath(this.logsDir)
      }
    } catch {
      // best effort
    }
  }
}

/** Create a log file empty so the path is real before async writes begin. */
function describeFile(p: string): void {
  try {
    writeFileSync(p, '', 'utf8')
  } catch {
    // best effort; appends will also create it lazily
  }
}

/**
 * History preferences straight from settings.
 *
 * Read on every use rather than cached: the store is constructed once at boot
 * but the user can flip the switch at any time, and a stale copy would keep
 * recording after they turned it off.
 */
function loadHistoryPrefs(): { historyEnabled: boolean; historyLimit: number } {
  try {
    const terminal = loadSettings().terminal
    return {
      historyEnabled: terminal.historyEnabled !== false,
      historyLimit: normalizeLimit(terminal.historyLimit)
    }
  } catch {
    // Settings unreadable (e.g. store used outside Electron in a test): fall
    // back to the same defaults the app ships with.
    return {
      historyEnabled: DEFAULT_SETTINGS.terminal.historyEnabled,
      historyLimit: DEFAULT_SETTINGS.terminal.historyLimit
    }
  }
}

/** Clamp a configured limit into 1..HISTORY_LIMIT_MAX; unusable → the default. */
function normalizeLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_SETTINGS.terminal.historyLimit
  const rounded = Math.floor(value)
  if (rounded < 1) return 1
  return Math.min(rounded, HISTORY_LIMIT_MAX)
}