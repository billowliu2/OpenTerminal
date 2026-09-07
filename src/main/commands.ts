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

/** Upper bound on recorded history entries. */
const HISTORY_CAP = 500

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

  /** Record one executed command: trim; dedupe vs newest; move to front; cap. */
  recordCommand(cmd: string): void {
    const trimmed = cmd.trim()
    if (!trimmed) return
    const data = this.loadCommands()
    const top = data.history[0]
    if (top && top.command === trimmed) {
      // Same as the newest entry: refresh its recency (already at the front).
      top.lastUsedAt = Date.now()
    } else {
      data.history.unshift({
        id: randomUUID(),
        command: trimmed,
        createdAt: Date.now(),
        lastUsedAt: Date.now()
      })
      if (data.history.length > HISTORY_CAP) data.history.length = HISTORY_CAP
    }
    this.saveCommands(data)
  }

  /** History sorted by most recently used. */
  listHistory(): CommandItem[] {
    return this.loadCommands()
      .history.slice()
      .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
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
    appendFile(meta.file, data, 'utf8').catch(() => {
      // file may have been removed after stop -> ignore
    })
  }

  /** Stop logging a session, stamping endedAt into the registry + index. */
  logStop(sessionId: string): void {
    const meta = this.activeBySession.get(sessionId)
    if (!meta) return
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