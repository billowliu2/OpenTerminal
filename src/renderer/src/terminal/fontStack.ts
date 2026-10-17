/**
 * CSS font-family quoting for the terminal font setting.
 *
 * The font enumerator (`src/main/ipc.ts`) asks the OS for plain names
 * (`fontList.getFonts({ disableQuoting: true })`), so `settings.terminal.fontFamily`
 * holds either one bare family name or a hand-written stack. The value is passed
 * verbatim to xterm's `fontFamily` option and to the settings preview's inline
 * style, where a name containing `(`, `)`, `+`, starting with a digit, or equal to
 * a CSS keyword no longer parses as a CSS family — we have only been getting away
 * with it because parsers are lenient. This module quotes each family on the way
 * out; the stored setting keeps the user's original text.
 *
 * Splitting respects quotes: commas inside `'Name, with comma'` or `"Name"` do not
 * separate families. Segments that are already quoted are kept as-is, bare
 * CSS-safe identifiers (and the keywords that must stay bare) are untouched, and
 * everything else gets double quotes with inner double quotes escaped. The result
 * is idempotent, so re-running it on already-processed output changes nothing.
 *
 * No imports on purpose: `tests/font-stack.mjs` imports this .ts file directly and
 * relies on Node >= 22.18 stripping the types.
 */

/** Family keywords that must stay unquoted to keep their CSS meaning. */
const CSS_KEYWORDS = new Set([
  'monospace',
  'serif',
  'sans-serif',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-monospace',
  'default',
  'inherit',
  'initial',
  'unset'
])

/** A CSS identifier that needs no quoting (letters, digits, `-`, `_`; no leading digit). */
const BARE_IDENTIFIER = /^[A-Za-z_-][A-Za-z0-9_-]*$/

/** Split a stack on top-level commas, leaving quoted spans (and their commas) intact. */
function splitTopLevel(stack: string): string[] {
  const parts: string[] = []
  let buffer = ''
  let quote: '"' | "'" | null = null

  for (let i = 0; i < stack.length; i += 1) {
    const ch = stack[i]
    if (quote) {
      buffer += ch
      if (ch === '\\' && i + 1 < stack.length) {
        buffer += stack[i + 1]
        i += 1
      } else if (ch === quote) {
        quote = null
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      buffer += ch
      continue
    }
    if (ch === ',') {
      parts.push(buffer)
      buffer = ''
      continue
    }
    buffer += ch
  }

  parts.push(buffer)
  return parts
}

/** True when the segment is already wrapped in a matching quote pair. */
function isQuoted(name: string): boolean {
  if (name.length < 2) return false
  const first = name[0]
  const last = name[name.length - 1]
  return (first === '"' || first === "'") && first === last
}

/** True when the segment can stay bare: a CSS-safe identifier or a family keyword. */
function staysBare(name: string): boolean {
  if (CSS_KEYWORDS.has(name.toLowerCase())) return true
  return BARE_IDENTIFIER.test(name)
}

/**
 * Normalize a font-family stack into a form CSS and canvas accept.
 * Empty segments are dropped; an empty/blank input yields the empty string.
 */
export function quoteFontStack(family: string): string {
  const out: string[] = []
  for (const raw of splitTopLevel(family)) {
    const name = raw.trim()
    if (!name) continue
    if (isQuoted(name) || staysBare(name)) {
      out.push(name)
      continue
    }
    // Escape backslashes as well as quotes: escaping only `"` turned a name with
    // a trailing backslash (`a\`) into `"a\"`, whose closing quote is itself
    // escaped — the CSS string never terminates and the font silently falls back.
    out.push(`"${name.replace(/[\\"]/g, '\\$&')}"`)
  }
  return out.join(', ')
}
