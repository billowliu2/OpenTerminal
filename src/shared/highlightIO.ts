import { isHighlightCategory, type HighlightRule } from './settings'

/**
 * Import / export of highlight rule sets — share a set with a colleague, or keep
 * a copy before experimenting.
 *
 * The envelope carries a kind + version so pasting the wrong JSON (a layout, a
 * connection list, a file from a future format) fails loudly instead of
 * importing nonsense. Validation here stays deliberately light: past that
 * envelope it only rejects what cannot be a rule at all (no `rules` array, an
 * unusable regex). Everything else is repaired by the settings store on save,
 * which already owns that job.
 */

export const HIGHLIGHT_FILE_KIND = 'openterminal.highlight-rules'
export const HIGHLIGHT_FILE_VERSION = 1

/** Default colour for an imported rule that lost its own. */
const FALLBACK_FG = '#3fb950'

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

export interface HighlightFile {
  kind: string
  version: number
  exportedAt: string
  rules: HighlightRule[]
}

/** Reasons a paste can be refused, as codes the UI turns into a message. */
export type ImportError = 'not-json' | 'no-rules' | 'wrong-kind' | 'wrong-version'

export interface ParsedHighlightFile {
  rules: HighlightRule[]
  /** One line per rule that was dropped, for the "N skipped" note. */
  warnings: string[]
  error?: ImportError
}

/** Serialize a rule set into the shareable envelope. */
export function exportHighlightRules(rules: HighlightRule[]): string {
  const file: HighlightFile = {
    kind: HIGHLIGHT_FILE_KIND,
    version: HIGHLIGHT_FILE_VERSION,
    exportedAt: new Date().toISOString(),
    rules
  }
  return JSON.stringify(file, null, 2)
}

/** Id for an imported rule, so it can never collide with an existing one. */
function freshId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `imported-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** Accepts the exported envelope, or a bare array of rules. */
export function parseHighlightRules(text: string): ParsedHighlightFile {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { rules: [], warnings: [], error: 'not-json' }
  }

  let list: unknown[]
  if (Array.isArray(raw)) {
    list = raw
  } else if (raw !== null && typeof raw === 'object' && Array.isArray((raw as { rules?: unknown }).rules)) {
    // An envelope is only trusted when both stamps match: a missing `kind`
    // means the JSON is not ours, and a foreign `version` means it was written
    // by a format this build does not know how to read.
    const { kind, version } = raw as { kind?: unknown; version?: unknown }
    if (kind !== HIGHLIGHT_FILE_KIND) {
      return { rules: [], warnings: [], error: 'wrong-kind' }
    }
    if (version !== HIGHLIGHT_FILE_VERSION) {
      return { rules: [], warnings: [], error: 'wrong-version' }
    }
    list = (raw as { rules: unknown[] }).rules
  } else {
    return { rules: [], warnings: [], error: 'no-rules' }
  }

  const rules: HighlightRule[] = []
  const warnings: string[] = []
  list.forEach((entry, index) => {
    const rule = coerceImported(entry, index, warnings)
    if (rule) rules.push(rule)
  })
  return { rules, warnings }
}

/** Keep the fields we understand; the store repairs the rest on save. */
function coerceImported(value: unknown, index: number, warnings: string[]): HighlightRule | null {
  if (value === null || typeof value !== 'object') {
    warnings.push(`#${index + 1}: not an object`)
    return null
  }
  const raw = value as Record<string, unknown>
  const pattern = typeof raw.pattern === 'string' ? raw.pattern.trim() : ''
  if (pattern === '') {
    warnings.push(`#${index + 1}: no pattern`)
    return null
  }
  try {
    // eslint-disable-next-line no-new
    new RegExp(pattern)
  } catch {
    warnings.push(`#${index + 1}: invalid regex`)
    return null
  }

  const color = raw.color !== null && typeof raw.color === 'object' ? (raw.color as Record<string, unknown>) : null
  const fg = typeof color?.fg === 'string' && HEX.test(color.fg) ? color.fg : FALLBACK_FG
  const bg = typeof color?.bg === 'string' && HEX.test(color.bg) ? color.bg : undefined
  const rawPriority = typeof raw.priority === 'number' ? raw.priority : Number(raw.priority)

  return {
    id: freshId(),
    pattern,
    enabled: raw.enabled !== false,
    priority: Number.isFinite(rawPriority) ? Math.min(100, Math.max(1, Math.round(rawPriority))) : 10,
    color: { fg, ...(bg ? { bg } : {}) },
    ...(Array.isArray(raw.bands) ? { bands: raw.bands as HighlightRule['bands'] } : {}),
    ...(raw.caseInsensitive === true ? { caseInsensitive: true } : {}),
    ...(raw.basic === true ? { basic: true } : {}),
    ...(isHighlightCategory(raw.category) ? { category: raw.category } : {}),
    ...(typeof raw.note === 'string' && raw.note.trim() !== '' ? { note: raw.note.trim() } : {}),
    builtin: false
  }
}

/** Merge imported rules into the current set: replace everything, or append. */
export function mergeRules(
  existing: HighlightRule[],
  incoming: HighlightRule[],
  mode: 'replace' | 'append'
): HighlightRule[] {
  if (mode === 'replace') return incoming
  const used = new Set(existing.map((rule) => rule.id))
  const appended = incoming.map((rule) => {
    if (!used.has(rule.id)) {
      used.add(rule.id)
      return rule
    }
    const id = freshId()
    used.add(id)
    return { ...rule, id }
  })
  return [...existing, ...appended]
}
