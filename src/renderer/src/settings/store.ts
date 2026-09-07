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
  /** shallow-merge into settings.system and persist */
  updateSystem: (partial: Partial<SystemSettings>) => Promise<void>
}

/** unsubscriber for the cross-window SETTINGS_CHANGED listener; held module-level so hydrate() is idempotent */
let unsubscribeStoreListener: (() => void) | null = null
/** re-entrancy guard so concurrent hydrate() calls don't double-subscribe */
let hydrating = false

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
    // optimistic update; the SETTINGS_CHANGED echo will re-set the same value (idempotent)
    set({ settings: next })
    try {
      await window.api.saveSettings(next)
    } catch (err) {
      console.error('[settings] updateTerminal failed, rolling back', err)
      set({ settings: prev })
    }
  },

  setCustomThemes: async (themes) => {
    const prev = get().settings
    const next: AppSettings = { ...prev, customThemes: themes }
    set({ settings: next })
    try {
      await window.api.saveSettings(next)
    } catch (err) {
      console.error('[settings] setCustomThemes failed, rolling back', err)
      set({ settings: prev })
    }
  },

  setHighlightRules: async (rules) => {
    const prev = get().settings
    const next: AppSettings = { ...prev, highlightRules: rules }
    // optimistic update; the SETTINGS_CHANGED echo will re-set the same value (idempotent)
    set({ settings: next })
    try {
      await window.api.saveSettings(next)
    } catch (err) {
      console.error('[settings] setHighlightRules failed, rolling back', err)
      set({ settings: prev })
    }
  },

  updateSystem: async (partial) => {
    const prev = get().settings
    const next: AppSettings = { ...prev, system: { ...prev.system, ...partial } }
    // optimistic update; the SETTINGS_CHANGED echo will re-set the same value (idempotent)
    set({ settings: next })
    try {
      await window.api.saveSettings(next)
    } catch (err) {
      console.error('[settings] updateSystem failed, rolling back', err)
      set({ settings: prev })
    }
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