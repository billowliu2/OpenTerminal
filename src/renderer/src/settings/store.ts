import type { AppSettings, SystemSettings, TerminalSettings } from '@shared/settings'
import { DEFAULT_SETTINGS } from '@shared/settings'
import type { TerminalTheme } from '@shared/theme'
import { getThemeById } from '@shared/theme'
import { create } from 'zustand'

export interface SettingsState {
  /** true once initial settings have been loaded from the main process */
  hydrated: boolean
  settings: AppSettings
  hydrate: () => Promise<void>
  /** shallow-merge into settings.terminal and persist */
  updateTerminal: (partial: Partial<TerminalSettings>) => Promise<void>
  /** replace customThemes array and persist */
  setCustomThemes: (themes: AppSettings['customThemes']) => Promise<void>
  /** replace highlightRules array and persist */
  setHighlightRules: (rules: AppSettings['highlightRules']) => Promise<void>
  /** replace highlightProfiles array and persist */
  setHighlightProfiles: (profiles: AppSettings['highlightProfiles']) => Promise<void>
  /** shallow-merge into settings.system and persist */
  updateSystem: (partial: Partial<SystemSettings>) => Promise<void>
}

/** unsubscriber for the cross-window SETTINGS_CHANGED listener; held module-level so hydrate() is idempotent */
let unsubscribeStoreListener: (() => void) | null = null
/** re-entrancy guard so concurrent hydrate() calls don't double-subscribe */
let hydrating = false

/** Sub-keys of `prev` → `next` that actually changed, or undefined when none did. */
function diffGroup<T extends object>(prev: T, next: T): Partial<T> | undefined {
  const patch: Partial<T> = {}
  for (const key of Object.keys(next) as (keyof T)[]) {
    if (prev[key] !== next[key]) patch[key] = next[key]
  }
  return Object.keys(patch).length > 0 ? patch : undefined
}

/**
 * Optimistic write + persist. The SETTINGS_CHANGED echo re-sets the same value
 * (idempotent), so no rollback is needed for it. On failure, revert only while
 * the store still holds exactly what this call wrote: a newer call (e.g. a
 * ColorPicker drag) may already have saved a different value, and reverting
 * would drop it from the UI although it is on disk.
 */
async function persist(
  get: () => SettingsState,
  set: (partial: Partial<SettingsState>) => void,
  written: AppSettings,
  prev: AppSettings,
  label: string
): Promise<void> {
  set({ settings: written })
  try {
    // Send a minimal patch, not the full snapshot: main lets stale-but-sent
    // fields win, so a snapshot captured before a main-process mutateSettings
    // write (e.g. the tray's persistCloseAction) would silently revert it.
    // Absent fields are left untouched on disk.
    const patch: Partial<AppSettings> = {}
    if (written.customThemes !== prev.customThemes) patch.customThemes = written.customThemes
    if (written.highlightRules !== prev.highlightRules) patch.highlightRules = written.highlightRules
    if (written.highlightProfiles !== prev.highlightProfiles) {
      patch.highlightProfiles = written.highlightProfiles
    }
    const terminal = diffGroup(prev.terminal, written.terminal)
    // Main merges each group one level deep, so a group holding only the
    // changed sub-keys is a valid patch payload even though the contract types
    // groups as full objects.
    if (terminal) patch.terminal = terminal as TerminalSettings
    const system = diffGroup(prev.system, written.system)
    if (system) patch.system = system as SystemSettings
    await window.api.saveSettings(patch)
  } catch (err) {
    console.error(`[settings] ${label} failed, rolling back`, err)
    if (get().settings === written) set({ settings: prev })
  }
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  hydrated: false,
  settings: DEFAULT_SETTINGS,

  hydrate: async () => {
    if (get().hydrated) return
    // guard against concurrent hydrate() calls racing on the first render
    if (hydrating) return
    hydrating = true
    try {
      const settings = await window.api.getSettings()
      set({ settings, hydrated: true })

      if (unsubscribeStoreListener === null) {
        unsubscribeStoreListener = window.api.onSettingsChanged((s: AppSettings) =>
          set({ settings: s })
        )
      }
    } catch (err) {
      console.error('[settings] hydrate failed', err)
    } finally {
      hydrating = false
    }
  },

  updateTerminal: async (partial) => {
    const prev = get().settings
    const next: AppSettings = {
      ...prev,
      terminal: { ...prev.terminal, ...partial }
    }
    await persist(get, set, next, prev, 'updateTerminal')
  },

  setCustomThemes: async (themes) => {
    const prev = get().settings
    const next: AppSettings = { ...prev, customThemes: themes }
    await persist(get, set, next, prev, 'setCustomThemes')
  },

  setHighlightRules: async (rules) => {
    const prev = get().settings
    const next: AppSettings = { ...prev, highlightRules: rules }
    await persist(get, set, next, prev, 'setHighlightRules')
  },

  setHighlightProfiles: async (profiles) => {
    const prev = get().settings
    const next: AppSettings = { ...prev, highlightProfiles: profiles }
    await persist(get, set, next, prev, 'setHighlightProfiles')
  },

  updateSystem: async (partial) => {
    const prev = get().settings
    const next: AppSettings = { ...prev, system: { ...prev.system, ...partial } }
    await persist(get, set, next, prev, 'updateSystem')
  }
}))

/**
 * Resolve the currently active TerminalTheme (builtin or custom) from the store.
 * Subscribes to settings so consumers re-render when the active theme changes.
 */
export function useResolvedTheme(): TerminalTheme {
  const settings = useSettingsStore((s) => s.settings)
  return getThemeById(settings.terminal.themeId, settings.customThemes)
}