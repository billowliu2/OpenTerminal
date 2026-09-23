import { t } from '@shared/i18n'
import type { HighlightRule } from '@shared/settings'

/**
 * Labels for a rule in the settings UI.
 *
 * Built-in rules store a zh-CN note and carry a `settings.highlight.builtin.<id>`
 * translation; `t()` returns the key itself when a translation is missing, which
 * is exactly how the two are told apart here.
 */

/** Translated note for a built-in rule, or the stored note for a user rule. */
export function ruleNote(rule: HighlightRule): string | undefined {
  const key = `settings.highlight.builtin.${rule.id}`
  const translated = t(key)
  if (translated !== key) return translated
  return rule.note !== undefined && rule.note !== '' ? rule.note : undefined
}

/** Label for a rule in a picker: its note, falling back to the pattern itself. */
export function ruleLabel(rule: HighlightRule): string {
  return ruleNote(rule) ?? rule.pattern
}
