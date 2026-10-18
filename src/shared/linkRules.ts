import type { LinkRule } from './settings'
// The explicit `.ts` extensions on the two imports below are deliberate:
// `tests/link-rules.mjs` loads this file directly through Node's type stripping,
// and Node's ESM resolver does not try extensions (measured: an extension-less
// specifier here fails with ERR_MODULE_NOT_FOUND). tsc raises TS5097 for the
// extension and nothing else, so the directive silences it — the import still
// resolves and stays fully typed.
// @ts-expect-error TS5097 — see above
import { LINK_RULE_FLAGS, MAX_PATTERN_LEN, ruleRunState, sanitizeRuleValidation, validationAllows, type RuleRunState } from './ruleValidation.ts'
// @ts-expect-error TS5097 — see above
import { PROBE_VERSION } from './redosProbes.ts'

/**
 * User-defined clickable link rules (WezTerm `hyperlink_rules` in spirit).
 *
 * A rule is a regex over the terminal's *logical* line plus a URL template: the
 * match becomes an underlined range, and a Ctrl/Cmd+Click opens the template
 * expanded with the capture groups. This module is the whole engine minus the
 * xterm plumbing — validation, template expansion and the non-overlapping span
 * merge — so it stays a pure module the Node test can load directly
 * (`tests/link-rules.mjs`), and nothing here can touch a terminal.
 *
 * Safety: `findRuleLinks` is the only producer of a rule-made target, and it
 * drops anything whose scheme is not http/https. A template is user input, and
 * `file://`, `javascript:` or an `ms-settings:` handler must never reach the
 * shell just because a pattern matched some output.
 *
 * The same fail-closed gate the highlight engine applies (`validationAllows`)
 * runs in `compileLinkRules`: a user pattern executes only with a proof that
 * matches it exactly. Link rules have NO built-in whitelist — none of them
 * ships with the app, so there is nothing to exempt.
 */

/** Longest pattern we accept; longer entries are dropped. One constant with
 *  the highlight rules and the engine (`MAX_PATTERN_LEN`), so a link pattern
 *  can never be admitted at a length the engine would refuse. */
export const LINK_PATTERN_MAX = MAX_PATTERN_LEN
export const LINK_TEMPLATE_MAX = 500
/** Note is a table caption, not documentation — same budget as a highlight rule. */
export const LINK_NOTE_MAX = 60
/** Upper bound on stored rules, so a runaway import cannot bloat settings.json. */
export const LINK_RULES_MAX = 100
/**
 * User patterns run against the rebuilt logical line. Past this length they are
 * skipped entirely: built-in URL matching is a fixed set of regexes, but a
 * user-supplied one can backtrack catastrophically, and a terminal can emit a
 * single-line log record of arbitrary length.
 */
export const LINK_TEXT_MAX = 4096
/** Per-rule match cap for one line, same reasoning as the text cap. */
const MAX_PER_RULE = 200

/**
 * Stable empty list for `settings.linkRules`. The field is optional, and a
 * selector that returned a fresh `[]` on every read would hand zustand's
 * equality check a new identity each time — re-rendering every terminal pane on
 * unrelated settings writes. Never mutated: every writer builds a new array.
 */
export const EMPTY_LINK_RULES: LinkRule[] = []

export interface CompiledLinkRule {
  id: string
  regex: RegExp
  template: string
}

/** A clickable range, in the same shape `urlLinks.findUrls` returns. */
export interface LinkSpan {
  /** absolute offset of the first character, within the logical line */
  start: number
  /** absolute offset one past the last character */
  end: number
  /** the clickable target, scheme already checked */
  url: string
}

/**
 * Validate a rule list coming from disk. Ids, patterns and templates are
 * required; a pattern that does not compile, an empty template and duplicate
 * ids are dropped (the settings table keys rows by id, and an uncompilable
 * regex would otherwise throw on every line the terminal draws).
 */
export function sanitizeLinkRules(
  raw: unknown,
  warn?: (message: string) => void
): LinkRule[] {
  if (!Array.isArray(raw)) return []
  const rules: LinkRule[] = []
  const seen = new Set<string>()
  raw.forEach((entry, index) => {
    if (entry === null || typeof entry !== 'object') {
      warn?.(`linkRules[${index}]: not an object — skipped`)
      return
    }
    const candidate = entry as Record<string, unknown>
    const { id, pattern, template } = candidate
    if (typeof id !== 'string' || id === '') {
      warn?.(`linkRules[${index}]: missing id — skipped`)
      return
    }
    if (seen.has(id)) {
      warn?.(`linkRules[${index}]: duplicate id — skipped`)
      return
    }
    if (typeof pattern !== 'string' || pattern.trim() === '') {
      warn?.(`linkRules[${index}]: missing pattern — skipped`)
      return
    }
    if (typeof template !== 'string' || template.trim() === '') {
      warn?.(`linkRules[${index}]: missing template — skipped`)
      return
    }
    if (pattern.length > LINK_PATTERN_MAX) {
      warn?.(`linkRules[${index}]: pattern too long — skipped`)
      return
    }
    if (template.length > LINK_TEMPLATE_MAX) {
      warn?.(`linkRules[${index}]: template too long — skipped`)
      return
    }
    if (!compiles(pattern)) {
      warn?.(`linkRules[${index}]: invalid regex — skipped`)
      return
    }
    if (rules.length >= LINK_RULES_MAX) {
      warn?.(`linkRules[${index}]: too many rules — skipped`)
      return
    }
    seen.add(id)
    const note = typeof candidate.note === 'string' ? candidate.note.trim() : ''
    // Internal metadata, so only its SHAPE is checked on load; the compile gate
    // re-checks it against the pattern, the flags and the probe version.
    const validation = sanitizeRuleValidation(candidate.validation)
    if (candidate.validation !== undefined && validation === undefined) {
      warn?.(`linkRules[${index}].validation: malformed — dropped`)
    }
    rules.push({
      id,
      pattern,
      template,
      // Absent means on: a rule the user just created and did not switch off.
      enabled: candidate.enabled !== false,
      ...(validation ? { validation } : {}),
      ...(note ? { note: note.slice(0, LINK_NOTE_MAX) } : {})
    })
  })
  return rules
}

function compiles(pattern: string): boolean {
  try {
    // eslint-disable-next-line no-new
    new RegExp(pattern)
    return true
  } catch {
    return false
  }
}

/**
 * Expand a template against one match: `$0` is the whole match, `$1`–`$9` the
 * capture groups (a group that did not participate expands to nothing), `$$`
 * is a literal `$`, and a `$` before anything else stays a literal `$`.
 *
 * Only one digit is ever consumed, so `$10` is group 1 followed by a literal
 * `0` — a rule with ten groups is out of scope, and resolving `$10` to a group
 * the match may not have would be the more surprising of the two readings.
 */
export function formatLinkTemplate(template: string, match: RegExpExecArray): string {
  let out = ''
  for (let i = 0; i < template.length; i++) {
    const char = template[i]
    if (char !== '$' || i + 1 >= template.length) {
      out += char
      continue
    }
    const next = template[i + 1]
    if (next === '$') {
      out += '$'
      i++
      continue
    }
    if (next >= '0' && next <= '9') {
      out += match[Number(next)] ?? ''
      i++
      continue
    }
    out += char
  }
  return out
}

/**
 * Whether a generated target may be handed to the OS. Only the web schemes are
 * allowed — the same gate the main process applies to `window.open`, repeated
 * here so an unusable target never even becomes an underlined range.
 */
export function isSafeLinkTarget(url: string): boolean {
  const trimmed = url.trim()
  if (trimmed === '') return false
  try {
    const { protocol } = new URL(trimmed)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    // unparsable / relative: nothing a browser could open
    return false
  }
}

/**
 * Whether a *template* can produce an openable target — the check the rule
 * editor needs before a match exists, so it judges the shape rather than one
 * expansion:
 *
 *   - a template that names `http://` or `https://` itself is fine;
 *   - one that starts with `$0`/`$1`–`$9` takes the scheme from the match, so it
 *     is accepted here and left to `isSafeLinkTarget` at click time (a `$0`
 *     rule over `https?://\S+` is the legitimate case);
 *   - anything else — `file:`, `javascript:`, a bare path, a leading space
 *     followed by a foreign scheme — is refused.
 */
export function isSafeLinkTemplate(template: string): boolean {
  const trimmed = template.trim()
  if (trimmed === '') return false
  if (/^https?:\/\//i.test(trimmed)) return true
  return /^\$[0-9]/.test(trimmed)
}

/** Keep only the rules that can actually run. */
export function compileLinkRules(rules: readonly LinkRule[] | undefined): CompiledLinkRule[] {
  if (!rules) return []
  const out: CompiledLinkRule[] = []
  for (const rule of rules) {
    if (rule.enabled === false) continue
    if (rule.pattern.trim() === '' || rule.template.trim() === '') continue
    // Fail-closed admission, exactly like the highlight engine's `compileRules`
    // (link rules pass no built-in whitelist: none of them ships with the app).
    // Without a `passed` proof for this precise pattern + flag string + probe
    // version the rule is inert — an imported set, a hand-edited settings.json,
    // a proof that expired with a corpus update or a pattern edited after the
    // fact all land here as "no proof", never as "probably fine".
    if (!validationAllows(rule.pattern, LINK_RULE_FLAGS, rule.validation, PROBE_VERSION)) continue
    try {
      out.push({ id: rule.id, regex: new RegExp(rule.pattern, LINK_RULE_FLAGS), template: rule.template })
    } catch {
      // sanitizeLinkRules already dropped these; a hand-edited settings.json or
      // a rule list built in memory could still carry one.
    }
  }
  return out
}

/**
 * How a link rule stands right now — the same derivation the highlight engine
 * exposes for its own rules, and the label the settings table shows. Link rules
 * have no built-in whitelist, so the states are `passed` / `pending` /
 * `quarantined` only.
 */
export function linkRuleRunState(rule: LinkRule): RuleRunState {
  return ruleRunState(rule.pattern, LINK_RULE_FLAGS, rule.validation, PROBE_VERSION)
}

/**
 * Every rule-made link on one logical line, in rule order (an earlier rule
 * claims its span first, like the highlight engine) and non-overlapping.
 * Targets failing the scheme gate are dropped without a sound.
 */
export function findRuleLinks(text: string, rules: readonly CompiledLinkRule[]): LinkSpan[] {
  if (rules.length === 0 || text === '' || text.length > LINK_TEXT_MAX) return []
  const out: LinkSpan[] = []
  for (const rule of rules) {
    const claimed: LinkSpan[] = []
    rule.regex.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = rule.regex.exec(text)) !== null) {
      // A pattern that can match the empty string would spin forever on the
      // same index: step past it instead of trusting lastIndex to advance.
      if (match[0] === '') {
        rule.regex.lastIndex = match.index + 1
        continue
      }
      if (claimed.length >= MAX_PER_RULE) break
      const start = match.index
      const end = start + match[0].length
      if (overlaps(out, start, end) || overlaps(claimed, start, end)) continue
      const url = formatLinkTemplate(rule.template, match).trim()
      if (!isSafeLinkTarget(url)) continue
      const span = { start, end, url }
      claimed.push(span)
      out.push(span)
    }
  }
  return out
}

function overlaps(spans: readonly LinkSpan[], start: number, end: number): boolean {
  return spans.some((span) => start < span.end && end > span.start)
}

/**
 * Combine the two link sources into one non-overlapping list: the primary
 * (user rules — a deliberate rule beats a heuristic) keeps every span it
 * claimed, the secondary (built-in URL detection) contributes only what does
 * not collide. Sorted by start, which is what the provider maps to cells.
 */
export function mergeLinkSpans(
  primary: readonly LinkSpan[],
  secondary: readonly LinkSpan[]
): LinkSpan[] {
  const kept: LinkSpan[] = [...primary]
  for (const span of secondary) {
    if (!overlaps(primary, span.start, span.end)) kept.push(span)
  }
  return kept.sort((a, b) => a.start - b.start || b.end - a.end)
}
