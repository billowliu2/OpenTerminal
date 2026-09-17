import { app, ipcMain, powerSaveBlocker } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { Ipc } from '../shared/ipc'
import {
  DEFAULT_HIGHLIGHT_RULES,
  DEFAULT_SETTINGS,
  type AppSettings,
  type HighlightRule,
  type SystemSettings,
  type TerminalSettings
} from '../shared/settings'
import type { TerminalTheme } from '../shared/theme'
import { broadcast } from './broadcast'
import { applyGlobalShortcut } from './globalShortcuts'
import { applyWindowChrome } from './windowChrome'

const settingsPath = (): string => join(app.getPath('userData'), 'settings.json')

const DEFAULT_SYSTEM: SystemSettings = {
  launchAtLogin: false,
  preventSleep: false,
  globalShowHide: '',
  // Must match DEFAULT_SETTINGS.system in @shared/settings — an "ask" here made
  // a fresh install prompt on close while the docs and UI promised tray.
  closeAction: 'tray',
  autoCheckUpdate: true
}

const TERMINAL_KEYS = new Set(Object.keys(DEFAULT_SETTINGS.terminal) as (keyof TerminalSettings)[])

/** Light structural check for a persisted highlight rule. */
function isHighlightRule(value: unknown): value is HighlightRule {
  if (value === null || typeof value !== 'object') return false
  const rule = value as Record<string, unknown>
  return (
    typeof rule.id === 'string' &&
    typeof rule.pattern === 'string' &&
    typeof rule.enabled === 'boolean' &&
    typeof rule.priority === 'number' &&
    rule.color !== null &&
    typeof rule.color === 'object' &&
    typeof (rule.color as { fg?: unknown }).fg === 'string'
  )
}

function sanitizeRules(value: unknown): HighlightRule[] {
  // An explicit empty array is a valid choice ("no highlighting"); only
  // malformed data falls back to the built-in rules. Returning the defaults for
  // [] made deleting the last rule look like it silently failed.
  if (!Array.isArray(value)) return DEFAULT_HIGHLIGHT_RULES
  return value.filter(isHighlightRule)
}

function deepMerge(raw: unknown): { settings: AppSettings; errors: string[] } {
  const errors: string[] = []
  let terminal: TerminalSettings = { ...DEFAULT_SETTINGS.terminal }
  let customThemes: unknown = DEFAULT_SETTINGS.customThemes
  let highlightRules: unknown = DEFAULT_HIGHLIGHT_RULES

  if (raw !== null && typeof raw === 'object') {
    const packageSettings = raw as { terminal?: unknown; customThemes?: unknown; highlightRules?: unknown }
    if (packageSettings.terminal !== null && typeof packageSettings.terminal === 'object') {
      const candidate = packageSettings.terminal as Record<string, unknown>
      const merged: Record<string, unknown> = { ...terminal }
      for (const key of TERMINAL_KEYS) {
        const keyType = typeof DEFAULT_SETTINGS.terminal[key]
        if (candidate[key] !== undefined && typeof candidate[key] === keyType) {
          merged[key] = candidate[key]
        } else if (candidate[key] !== undefined) {
          errors.push(`terminal.${key}`)
        }
      }
      terminal = merged as unknown as TerminalSettings
    }
    if (Array.isArray(packageSettings.customThemes)) {
      customThemes = packageSettings.customThemes
    }
    if (packageSettings.highlightRules !== undefined) {
      highlightRules = packageSettings.highlightRules
    }
  }

  let system: unknown = DEFAULT_SYSTEM
  if (raw !== null && typeof raw === 'object') {
    const sys = (raw as { system?: unknown }).system
    if (sys !== null && typeof sys === 'object') {
      const candidate = sys as Record<string, unknown>
      const globalShowHide =
        typeof candidate.globalShowHide === 'string' ? candidate.globalShowHide : ''
      const closeAction =
        candidate.closeAction === 'tray' || candidate.closeAction === 'exit'
          ? candidate.closeAction
          : 'tray'
      system = {
        launchAtLogin: candidate.launchAtLogin === true,
        preventSleep: candidate.preventSleep === true,
        globalShowHide,
        closeAction,
        autoCheckUpdate: candidate.autoCheckUpdate !== false,
        // Both default on/off as in DEFAULT_SETTINGS; absent means "not chosen".
        restoreSession: candidate.restoreSession !== false,
        shellIntegration: candidate.shellIntegration === true
      }
    }
  }

  const themes: TerminalTheme[] = Array.isArray(customThemes) ? (customThemes as TerminalTheme[]) : []

  return {
    settings: {
      terminal,
      customThemes: themes,
      highlightRules: sanitizeRules(highlightRules),
      system: system as SystemSettings
    },
    errors
  }
}

// ---- real system side effects ------------------------------------------------

let sleepBlockerId: number | undefined

/** Apply OS-level effects of the system settings (login item, sleep blocker). */
function applySystemSettings(system: SystemSettings): void {
  try {
    app.setLoginItemSettings({ openAtLogin: system.launchAtLogin })
  } catch (err) {
    console.error('[settings] setLoginItemSettings failed', err)
  }
  if (system.preventSleep && sleepBlockerId === undefined) {
    sleepBlockerId = powerSaveBlocker.start('prevent-app-suspension')
  } else if (!system.preventSleep && sleepBlockerId !== undefined) {
    powerSaveBlocker.stop(sleepBlockerId)
    sleepBlockerId = undefined
  }
  // Re-register the global show/hide shortcut whenever system settings change.
  applyGlobalShortcut(system.globalShowHide)
}

/** Apply system side effects for the settings loaded at startup. */
export function applyStartupSystemSettings(settings: AppSettings): void {
  applySystemSettings(settings.system)
}

export function loadSettings(): AppSettings {
  try {
    const raw: unknown = JSON.parse(readFileSync(settingsPath(), 'utf8'))
    const { settings } = deepMerge(raw)
    return settings
  } catch {
    return {
      terminal: { ...DEFAULT_SETTINGS.terminal },
      customThemes: [...DEFAULT_SETTINGS.customThemes],
      highlightRules: DEFAULT_HIGHLIGHT_RULES.map((rule) => ({ ...rule })),
      system: { ...DEFAULT_SYSTEM }
    }
  }
}

let settingsQueue: Promise<unknown> = Promise.resolve()

/**
 * Serialize a settings mutation against every other writer. Each queued step
 * re-reads the file so the mutation applies on top of the latest state — a
 * full-snapshot save can no longer silently revert a change written between
 * its read and its write (e.g. tray close-action vs settings UI save).
 */
export function mutateSettings(mutate: (settings: AppSettings) => AppSettings): Promise<AppSettings> {
  const run = settingsQueue.then((): AppSettings => {
    const merged = deepMerge(mutate(loadSettings())).settings
    applySystemSettings(merged.system)
    applyWindowChrome(merged)

    mkdirSync(app.getPath('userData'), { recursive: true })
    const path = settingsPath()
    const tmp = `${path}.tmp`
    writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf8')
    renameSync(tmp, path)

    broadcast(Ipc.SETTINGS_CHANGED, merged)
    return merged
  })
  // Keep the queue alive when a mutation throws; the caller still sees it.
  settingsQueue = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

/** Replace the persisted settings with `next` (serialized). */
export function saveSettings(next: AppSettings): Promise<AppSettings> {
  return mutateSettings((current) => ({ ...current, ...next }))
}

export function registerSettingsIpc(): void {
  ipcMain.handle(Ipc.SETTINGS_GET, () => loadSettings())
  ipcMain.handle(Ipc.SETTINGS_SET, (_event, next: AppSettings) => saveSettings(next))
}