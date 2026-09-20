/**
 * Tiny dependency-free i18n core, shared by the renderer and the main process.
 *
 * Dictionaries are flat `key -> text` maps split by namespace, one file per
 * language per namespace (`dicts/<lang>/<namespace>.ts`). Ownership map — each
 * namespace is translated by whoever owns that area, so parallel work never
 * edits the same file:
 *
 *   common    — i18n plumbing: language names, generic buttons/status
 *   settings  — the settings dialog (font/cursor/render/highlight/theme/system/about)
 *   workspace — workspace shell: sidebar, tabs, layout menu, split, empty state
 *   terminal  — terminal view internals: context menu, search, paste confirm, toolbar
 *   ssh       — ssh connections, host key prompt, file panel, zmodem, monitor
 *   panels    — command panel, session-log panel, transfer panel
 *   main      — main-process strings: tray, close prompt, updater
 *
 * Missing keys fall back to zh-CN, then to the key itself (so a missing
 * translation is visible, never blank).
 */

import zhCN from './dicts/zh-CN'
import zhTW from './dicts/zh-TW'
import en from './dicts/en'
import ja from './dicts/ja'

export type Language = 'zh-CN' | 'zh-TW' | 'en' | 'ja'

export interface LanguageOption {
  value: Language
  /** Language names are shown in their own script, so this is not translated. */
  label: string
}

export const LANGUAGES: LanguageOption[] = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'zh-TW', label: '繁體中文' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' }
]

export const DEFAULT_LANGUAGE: Language = 'zh-CN'

export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && LANGUAGES.some((l) => l.value === value)
}

export type Dict = Record<string, string>

const DICTS: Record<Language, Dict> = {
  'zh-CN': zhCN,
  'zh-TW': zhTW,
  en,
  ja
}

let current: Language = DEFAULT_LANGUAGE
const listeners = new Set<(lang: Language) => void>()

/** Switch the active language and notify subscribers (renderer re-render,
 *  main-process tray rebuild). Both processes call this on settings load/save. */
export function setLanguage(lang: Language): void {
  if (current === lang) return
  current = lang
  for (const listener of listeners) listener(lang)
}

export function getLanguage(): Language {
  return current
}

export function onLanguageChange(cb: (lang: Language) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** Translate `key`; `{name}` placeholders are filled from `vars`. */
export function t(key: string, vars?: Record<string, string | number>): string {
  const raw = DICTS[current][key] ?? DICTS[DEFAULT_LANGUAGE][key] ?? key
  if (!vars) return raw
  return raw.replace(/\{(\w+)\}/g, (match, name: string) =>
    vars[name] === undefined ? match : String(vars[name])
  )
}
