import { app, ipcMain, powerSaveBlocker } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { Ipc } from '../shared/ipc'
import {
  DEFAULT_HIGHLIGHT_RULES,
  DEFAULT_SETTINGS,
  isHighlightCategory,
  isLockAutoDelay,
  lockAutoDelayOf,
  type AppSettings,
  type HighlightRule,
  type LockSettings,
  type SystemSettings,
  type TerminalSettings
} from '../shared/settings'
import { DEFAULT_DARK, type TerminalTheme, type ThemeColors } from '../shared/theme'
import { DEFAULT_LANGUAGE, isLanguage, setLanguage } from '../shared/i18n'
import { sanitizeProfiles } from '../shared/highlightProfiles'
import { broadcast } from './broadcast'
import { writeJson } from './store'
import { applyGlobalShortcut } from './globalShortcuts'
import { applyWindowChrome } from './windowChrome'

const settingsPath = (): string => join(app.getPath('userData'), 'settings.json')

/**
 * Snapshot of the shared system defaults, derived rather than retyped so the two
 * cannot drift (a hand-written copy once shipped closeAction 'ask', which made a
 * fresh install prompt on close while the docs and UI promised the tray).
 */
const DEFAULT_SYSTEM: SystemSettings = { ...DEFAULT_SETTINGS.system }

const TERMINAL_KEYS = new Set(Object.keys(DEFAULT_SETTINGS.terminal) as (keyof TerminalSettings)[])

/** Load-time warnings (bad terminal keys, repaired/dropped rules). Surfaced via
 *  reportWarnings() so a hand-edited or migrated settings.json leaves a trace
 *  instead of silently losing data. */
type Warnings = string[]

/** Fallback colour for a rule whose own colour is unusable. */
const DEFAULT_RULE_COLOR = '#e3b341'

/** Repair one persisted rule instead of dropping it. Shape problems with an
 *  obvious fix (priority as "5", enabled as 1/0, a missing fg colour) are
 *  corrected; only entries that cannot be a rule at all are skipped. Unknown
 *  extra fields are preserved so newer/older schemas survive a round trip. */
function coerceRule(value: unknown, index: number, warnings: Warnings): HighlightRule | null {
  if (value === null || typeof value !== 'object') {
    warnings.push(`highlightRules[${index}]: not an object — skipped`)
    return null
  }
  const rule = value as Record<string, unknown>
  if (typeof rule.id !== 'string' || typeof rule.pattern !== 'string') {
    warnings.push(`highlightRules[${index}]: missing id/pattern — skipped`)
    return null
  }

  let enabled = true
  if (typeof rule.enabled === 'boolean') enabled = rule.enabled
  else if (rule.enabled === 1 || rule.enabled === 0) {
    enabled = rule.enabled === 1
    warnings.push(`highlightRules[${index}].enabled repaired: ${String(rule.enabled)} → ${enabled}`)
  } else if (rule.enabled !== undefined) {
    warnings.push(`highlightRules[${index}].enabled repaired → true`)
  }

  const rawPriority = typeof rule.priority === 'number' ? rule.priority : Number(rule.priority)
  let priority = 10
  if (Number.isFinite(rawPriority)) {
    priority = Math.min(100, Math.max(1, Math.round(rawPriority)))
    if (priority !== rule.priority) {
      warnings.push(`highlightRules[${index}].priority repaired: ${String(rule.priority)} → ${priority}`)
    }
  } else {
    warnings.push(`highlightRules[${index}].priority repaired → ${priority}`)
  }

  const color: { fg: string; bg?: string } = { fg: DEFAULT_RULE_COLOR }
  if (rule.color !== null && typeof rule.color === 'object') {
    const candidate = rule.color as Record<string, unknown>
    if (typeof candidate.fg === 'string' && candidate.fg !== '') color.fg = candidate.fg
    else warnings.push(`highlightRules[${index}].color.fg repaired → ${DEFAULT_RULE_COLOR}`)
    if (typeof candidate.bg === 'string' && candidate.bg !== '') color.bg = candidate.bg
  } else {
    warnings.push(`highlightRules[${index}].color repaired → ${DEFAULT_RULE_COLOR}`)
  }

  if (rule.caseInsensitive !== undefined && typeof rule.caseInsensitive !== 'boolean') {
    warnings.push(`highlightRules[${index}].caseInsensitive ignored (not a boolean)`)
  }
  if (rule.basic !== undefined && typeof rule.basic !== 'boolean') {
    warnings.push(`highlightRules[${index}].basic ignored (not a boolean)`)
  }
  if (rule.category !== undefined && !isHighlightCategory(rule.category)) {
    warnings.push(`highlightRules[${index}].category ignored (unknown value)`)
  }

  // Value bands are repaired one entry at a time: a band without a usable min or
  // colour is dropped, and what survives is sorted so the engine can walk it.
  let bands: { min: number; fg: string }[] | undefined
  if (rule.bands !== undefined) {
    if (Array.isArray(rule.bands)) {
      const kept: { min: number; fg: string }[] = []
      rule.bands.forEach((entry, bandIndex) => {
        const band = entry !== null && typeof entry === 'object' ? (entry as Record<string, unknown>) : null
        const min = typeof band?.min === 'number' ? band.min : Number(band?.min)
        const fg = typeof band?.fg === 'string' ? band.fg.trim() : ''
        if (band === null || !Number.isFinite(min) || !/^#[0-9a-fA-F]{3}$|^#[0-9a-fA-F]{6}$/.test(fg)) {
          warnings.push(`highlightRules[${index}].bands[${bandIndex}]: unusable — skipped`)
          return
        }
        kept.push({ min, fg })
      })
      kept.sort((a, b) => a.min - b.min)
      if (kept.length > 0) bands = kept
    } else {
      warnings.push(`highlightRules[${index}].bands ignored (not an array)`)
    }
  }

  return {
    ...rule,
    id: rule.id,
    pattern: rule.pattern,
    enabled,
    priority,
    color,
    bands,
    // `undefined` rather than `false` so the flag stays absent unless it is on.
    caseInsensitive: rule.caseInsensitive === true ? true : undefined,
    basic: rule.basic === true ? true : undefined,
    category: isHighlightCategory(rule.category) ? rule.category : undefined,
    note: typeof rule.note === 'string' ? rule.note : undefined
  } as HighlightRule
}

/**
 * Preset patterns shipped by earlier versions, keyed by rule id. A built-in rule
 * whose pattern is still one of these was never edited by the user, so the
 * load-time refresh below may swap in the current preset for it.
 */
const LEGACY_BUILTIN_PATTERNS: Record<string, string[]> = {
  okstate: ['\\b(SUCCESS|PASS|OK|DONE|PASSED)\\b'],
  badstate: ['\\b(FAILED|ERROR|FAIL|FATAL|WARN|WARNING|DENIED)\\b']
}

/** Built-in ids of the preset set as it stood before `warnstate`/`danger` existed. */
const LEGACY_BUILTIN_IDS = [
  'perm',
  'path',
  'shellkw',
  'okstate',
  'badstate',
  'quoted',
  'envvar',
  'ipv4',
  'datetime',
  'numbers',
  'url'
]

/**
 * Carry an older install's preset rules onto the current ones.
 *
 * An upgrade must not throw the user's own work away, so both steps are guarded:
 *  - a built-in rule still holding a shipped pattern is refreshed in place; the
 *    pattern and case flag come from the preset, while id, colour, priority,
 *    note and the enabled switch stay exactly as the user left them;
 *  - preset rules that did not exist yet are appended only while the stored set
 *    is still exactly the older preset set (nothing deleted, nothing added) —
 *    the moment the list is the user's own, a rule they removed stays removed.
 * Both steps are idempotent: a refreshed pattern no longer matches a legacy one,
 * and an upgraded set never matches the older preset id list again.
 */
function refreshBuiltinRules(rules: HighlightRule[], warnings: Warnings): HighlightRule[] {
  const presets = new Map(DEFAULT_HIGHLIGHT_RULES.map((rule) => [rule.id, rule]))
  let changed = false
  const refreshed = rules.map((rule) => {
    const legacy = LEGACY_BUILTIN_PATTERNS[rule.id]
    const preset = presets.get(rule.id)
    if (!legacy || preset === undefined || rule.builtin !== true || !legacy.includes(rule.pattern)) {
      return rule
    }
    changed = true
    warnings.push(`highlightRules.${rule.id}: preset pattern updated`)
    return { ...rule, pattern: preset.pattern, caseInsensitive: preset.caseInsensitive }
  })

  // Presets added since are appended only while the stored set is *exactly* the
  // older preset set. Anything else — a rule deleted, one added by hand — means
  // the set is the user's, and a preset they threw away must not come back on
  // every load.
  const present = refreshed.map((rule) => rule.id)
  const pristine =
    present.length === LEGACY_BUILTIN_IDS.length &&
    LEGACY_BUILTIN_IDS.every((id) => present.includes(id))
  if (!pristine) return changed ? refreshed : rules
  const missing = DEFAULT_HIGHLIGHT_RULES.filter((rule) => !present.includes(rule.id))
  if (missing.length === 0) return changed ? refreshed : rules
  for (const rule of missing) warnings.push(`highlightRules.${rule.id}: new built-in rule added`)
  return [...refreshed, ...missing.map((rule) => ({ ...rule }))].sort((a, b) => a.priority - b.priority)
}

function sanitizeRules(value: unknown, warnings: Warnings): HighlightRule[] {
  // An explicit empty array is a valid choice ("no highlighting"); only
  // malformed data falls back to the built-in rules. Returning the defaults for
  // [] made deleting the last rule look like it silently failed.
  if (!Array.isArray(value)) return DEFAULT_HIGHLIGHT_RULES
  const rules: HighlightRule[] = []
  value.forEach((entry, index) => {
    const rule = coerceRule(entry, index, warnings)
    if (rule) rules.push(rule)
  })
  return refreshBuiltinRules(rules, warnings)
}

const THEME_COLOR_KEYS = Object.keys(DEFAULT_DARK.colors) as (keyof ThemeColors)[]

/**
 * Validate custom themes, repairing colours instead of dropping the theme.
 *
 * These reach `getThemeById`, which does a bare `.find()` over the list and
 * hands the result to xterm *and* to the window/title-bar colours — an entry
 * without an id or without colours used to throw inside `whenReady`, i.e. before
 * the tray and updater were wired, leaving a windowless process holding the
 * single-instance lock. Every colour missing from the stored entry is filled
 * from the built-in dark theme so a theme is always complete.
 */
function sanitizeThemes(value: unknown, warnings: Warnings): TerminalTheme[] {
  if (!Array.isArray(value)) return []
  const themes: TerminalTheme[] = []
  value.forEach((entry, index) => {
    if (entry === null || typeof entry !== 'object') {
      warnings.push(`customThemes[${index}]: not an object — skipped`)
      return
    }
    const theme = entry as Record<string, unknown>
    if (typeof theme.id !== 'string' || theme.id === '' || typeof theme.name !== 'string') {
      warnings.push(`customThemes[${index}]: missing id/name — skipped`)
      return
    }
    if (theme.colors === null || typeof theme.colors !== 'object') {
      warnings.push(`customThemes[${index}].colors repaired → built-in dark palette`)
    }
    const candidate =
      theme.colors !== null && typeof theme.colors === 'object'
        ? (theme.colors as Record<string, unknown>)
        : null
    const colors: ThemeColors = { ...DEFAULT_DARK.colors }
    const target = colors as unknown as Record<string, string>
    const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i
    for (const key of THEME_COLOR_KEYS) {
      const color = candidate?.[key]
      // Only well-formed hex colours survive: xterm would render anything else
      // as black, and the theme editor's native colour input needs #rrggbb.
      if (typeof color === 'string' && HEX_COLOR.test(color.trim())) {
        target[key] = color.trim()
      } else if (color !== undefined) {
        warnings.push(`customThemes[${index}].colors.${key}: not a hex color — repaired`)
      }
    }
    themes.push({
      ...theme,
      id: theme.id,
      name: theme.name,
      builtin: theme.builtin === true,
      colors
    } as TerminalTheme)
  })
  return themes
}

/**
 * Sanitize the lock block. Every field is forced to its type, so a partial
 * patch, a hand-edited file or a config written before the block existed all
 * land on the defaults; the delay must be one of the offered steps, because an
 * arbitrary number here would silently change the idle-lock schedule.
 */
function sanitizeLock(value: unknown, errors: string[]): LockSettings {
  const candidate =
    value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  if (candidate.autoLockMinutes !== undefined && !isLockAutoDelay(candidate.autoLockMinutes)) {
    errors.push('lock.autoLockMinutes')
  }
  return {
    enabled: candidate.enabled === true,
    autoLockMinutes: lockAutoDelayOf(candidate.autoLockMinutes),
    lockAtStartup: candidate.lockAtStartup === true
  }
}

function deepMerge(raw: unknown): { settings: AppSettings; errors: string[] } {
  const errors: string[] = []
  const lock = sanitizeLock(
    raw !== null && typeof raw === 'object' ? (raw as { lock?: unknown }).lock : undefined,
    errors
  )
  let terminal: TerminalSettings = { ...DEFAULT_SETTINGS.terminal }
  let customThemes: unknown = DEFAULT_SETTINGS.customThemes
  let highlightRules: unknown = DEFAULT_HIGHLIGHT_RULES
  let highlightProfiles: unknown = []

  if (raw !== null && typeof raw === 'object') {
    const packageSettings = raw as {
      terminal?: unknown
      customThemes?: unknown
      highlightRules?: unknown
      highlightProfiles?: unknown
    }
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
    if (packageSettings.highlightProfiles !== undefined) {
      highlightProfiles = packageSettings.highlightProfiles
    }
  }

  let system: unknown = { ...DEFAULT_SYSTEM }
  if (raw !== null && typeof raw === 'object') {
    const sys = (raw as { system?: unknown }).system
    if (sys !== null && typeof sys === 'object') {
      const candidate = sys as Record<string, unknown>
      const globalShowHide =
        typeof candidate.globalShowHide === 'string' ? candidate.globalShowHide : ''
      const closeAction =
        candidate.closeAction === 'tray' ||
        candidate.closeAction === 'exit' ||
        candidate.closeAction === 'ask'
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
        shellIntegration: candidate.shellIntegration === true,
        language: isLanguage(candidate.language) ? candidate.language : DEFAULT_LANGUAGE
      }
    }
  }

  const themes = sanitizeThemes(customThemes, errors)
  const rules = sanitizeRules(highlightRules, errors)

  return {
    settings: {
      terminal,
      customThemes: themes,
      highlightRules: rules,
      highlightProfiles: sanitizeProfiles(
        highlightProfiles,
        new Set(rules.map((rule) => rule.id)),
        (message) => errors.push(message)
      ),
      system: system as SystemSettings,
      lock
    },
    errors
  }
}

// ---- real system side effects ------------------------------------------------

let sleepBlockerId: number | undefined

/** Apply OS-level effects of the system settings (login item, sleep blocker). */
function applySystemSettings(system: SystemSettings): void {
  // The main process renders its own strings (tray menu, dialogs), so it tracks
  // the language itself; subscribers rebuild whatever they own.
  setLanguage(system.language ?? DEFAULT_LANGUAGE)
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

/**
 * Persist load-time warnings to `<userData>/settings-warnings.log`.
 *
 * Repeated identical warnings are collapsed (loadSettings runs on every save and
 * on every command-history write) and the file is trimmed when it grows, so a
 * broken config leaves a trace without filling the disk.
 */
let lastWarnings = ''

function reportWarnings(warnings: string[]): void {
  const line = warnings.join('; ')
  if (!line) {
    lastWarnings = ''
    return
  }
  if (line === lastWarnings) return
  lastWarnings = line
  try {
    const file = join(app.getPath('userData'), 'settings-warnings.log')
    const existing = existsSync(file) ? readFileSync(file, 'utf8') : ''
    const kept = existing.length > 64 * 1024 ? existing.slice(-32 * 1024) : existing
    writeFileSync(file, `${kept}[${new Date().toISOString()}] ${line}\n`, 'utf8')
  } catch {
    // best effort: warnings must never break settings loading
  }
}

export function loadSettings(): AppSettings {
  try {
    const raw: unknown = JSON.parse(readFileSync(settingsPath(), 'utf8'))
    const { settings, errors } = deepMerge(raw)
    reportWarnings(errors)
    return settings
  } catch {
    return {
      terminal: { ...DEFAULT_SETTINGS.terminal },
      customThemes: [...DEFAULT_SETTINGS.customThemes],
      highlightRules: DEFAULT_HIGHLIGHT_RULES.map((rule) => ({ ...rule })),
      highlightProfiles: [],
      system: { ...DEFAULT_SYSTEM },
      lock: { ...DEFAULT_SETTINGS.lock }
    }
  }
}

let settingsQueue: Promise<unknown> = Promise.resolve()

/**
 * One-time reset for existing installs: input suggestions and command history
 * are now off by default, but installs that upgraded from earlier versions
 * already have `true` persisted — flip those off exactly once, then leave a
 * marker so the user's later choices are never touched again.
 */
function migrateDefaultsOnce(): void {
  try {
    const flag = join(app.getPath('userData'), '.migrate-defaults-v2')
    if (existsSync(flag)) return
    const current = loadSettings()
    if (current.terminal.suggestEnabled || current.terminal.historyEnabled) {
      current.terminal.suggestEnabled = false
      current.terminal.historyEnabled = false
      writeJson(settingsPath(), current)
    }
    writeFileSync(flag, '', 'utf8')
  } catch {
    // best effort: a failed migration just keeps the old values
  }
}

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

    // writeJson gives the same atomic write as every other store, including
    // short EPERM/EBUSY retries when Windows holds the destination open.
    writeJson(settingsPath(), merged)

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

/** Merge a (partial) settings patch into the persisted settings. */
export function saveSettings(next: Partial<AppSettings>): Promise<AppSettings> {
  // system/terminal merge one level deep, so a partial patch cannot wipe sibling
  // keys. The renderer now sends a minimal patch, so *absent* fields no longer
  // win over the stored state; stale-but-sent fields still do, which is why
  // main-process writes go through mutateSettings on the freshly read state
  // instead of this path.
  return mutateSettings((current) => ({
    ...current,
    ...next,
    terminal: { ...current.terminal, ...next.terminal },
    system: { ...current.system, ...next.system },
    lock: { ...current.lock, ...next.lock }
  }))
}

export function registerSettingsIpc(): void {
  migrateDefaultsOnce()
  ipcMain.handle(Ipc.SETTINGS_GET, () => loadSettings())
  ipcMain.handle(Ipc.SETTINGS_SET, (_event, next: Partial<AppSettings>) => saveSettings(next))
}