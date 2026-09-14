import { app, ipcMain } from 'electron'
import { join } from 'path'
import { Ipc, type SessionPanelState, type SessionSnapshot } from '../shared/ipc'
import { isRecord, readJson, writeJson } from './store'

/**
 * The automatic session snapshot: dockview layouts plus a per-panel record, so
 * the next launch can restore the arrangement and drop every pane back into the
 * directory it was in.
 *
 * Distinct from the user-managed layout *templates* (`layouts/`): templates are
 * deliberately saved/loaded sets of layouts, the snapshot is the single
 * "where I left off" memory. They coexist.
 */

const MAX_PANELS = 64
/** A layout is a few KB; anything past this is a bug or a runaway, not a layout. */
const MAX_LAYOUT_BYTES = 2 * 1024 * 1024

const snapshotPath = (): string => join(app.getPath('userData'), 'session.json')

function isPanel(value: unknown): value is SessionPanelState {
  if (!isRecord(value)) return false
  return (
    typeof value.panelId === 'string' &&
    typeof value.title === 'string' &&
    (value.kind === 'local' || value.kind === 'ssh') &&
    (value.cwd === undefined || typeof value.cwd === 'string') &&
    (value.connectionId === undefined || typeof value.connectionId === 'string') &&
    (value.hostLabel === undefined || typeof value.hostLabel === 'string')
  )
}

/** Parse defensively: a corrupt snapshot must degrade to "no snapshot". */
function sanitize(raw: unknown): SessionSnapshot | null {
  if (!isRecord(raw)) return null
  const layouts = isRecord(raw.layouts) ? raw.layouts : {}
  const panels = Array.isArray(raw.panels) ? raw.panels.filter(isPanel).slice(0, MAX_PANELS) : []
  if (panels.length === 0 && !layouts.terminal && !layouts.ssh) return null

  const encode = (value: unknown): unknown => {
    if (value === undefined || value === null) return undefined
    // Cheap size guard: serializing here means a too-large layout is dropped
    // rather than written to disk on every save.
    try {
      const json = JSON.stringify(value)
      return json.length > MAX_LAYOUT_BYTES ? undefined : value
    } catch {
      return undefined
    }
  }

  return {
    version: 1,
    savedAt: typeof raw.savedAt === 'number' ? raw.savedAt : Date.now(),
    mode: raw.mode === 'ssh' ? 'ssh' : 'terminal',
    layouts: { terminal: encode(layouts.terminal), ssh: encode(layouts.ssh) },
    panels,
    lastLocalCwd: typeof raw.lastLocalCwd === 'string' ? raw.lastLocalCwd : undefined
  }
}

export function loadSessionSnapshot(): SessionSnapshot | null {
  return sanitize(readJson(snapshotPath()))
}

export function saveSessionSnapshot(next: SessionSnapshot): SessionSnapshot | null {
  const clean = sanitize(next)
  if (!clean) return null
  clean.savedAt = Date.now()
  writeJson(snapshotPath(), clean)
  return clean
}

export function clearSessionSnapshot(): void {
  writeJson(snapshotPath(), { version: 1, savedAt: Date.now(), mode: 'terminal', layouts: {}, panels: [] })
}

export function registerSessionStateIpc(): void {
  ipcMain.handle(Ipc.SESSION_STATE_GET, () => loadSessionSnapshot())
  ipcMain.handle(Ipc.SESSION_STATE_SET, (_event, snapshot: SessionSnapshot) => saveSessionSnapshot(snapshot))
}
