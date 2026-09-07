import type { HighlightRule } from '@shared/settings'

/**
 * Keyword highlight engine.
 *
 * Pure functions (no React / electron / xterm deps) that rewrite plain terminal
 * text into ANSI truecolor SGR runs *before* it is handed to xterm. Escape
 * sequences are never matched; only plain-text segments are, rule-by-rule in
 * ascending priority order, each rule claiming spans that later (lower-
 * priority) rules must not overlap.
 */

export interface CompiledRule {
  id: string
  /** compiled with the 'g' flag, pattern's own flags otherwise untouched */
  regex: RegExp
  /** hex fg, e.g. "#3fb950" — converted to rgb only at wrap time */
  fg: string
  /** optional hex bg */
  bg?: string
  /** copied from the source rule for stable priority ordering */
  priority: number
}

type Token = { kind: 'seq' | 'text'; value: string }
type Span = { start: number; end: number; fg: string; bg?: string }

/** ANSI escape tokens: CSI, OSC, two-char (ESC ( / ) ..), and ESC = / > . */
const ESCAPE_RE =
  /(\x1b\[[0-9;:?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-B]|\x1b[=>])/g

/** Matches a single rule may inject per chunk (bomb guard). */
const MAX_PER_RULE = 300
/** Chunks larger than this are returned unmodified (budget guard). */
const MAX_CHUNK = 512 * 1024

/** "#rrggbb" or 3-digit "#rgb" → {r,g,b}; any malformed input → white. */
export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  let h = (hex || '').trim().replace(/^#/, '')
  if (h.length === 3) h = h.replace(/./g, (c) => c + c)
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return { r: 255, g: 255, b: 255 }
  const n = parseInt(h, 16)
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff }
}

/** Split a chunk into escape-sequence tokens and plain-text runs. */
export function tokenize(input: string): Token[] {
  const out: Token[] = []
  let acc = ''
  let i = 0
  let m: RegExpExecArray | null
  // No /y — anchored alternations (e.g. a leading `^...` rule) still need to
  // try matching at position 0 of each run. lastIndex is reset per call.
  while ((m = ESCAPE_RE.exec(input)) !== null) {
    if (m.index > i) acc += input.slice(i, m.index)
    if (acc.length > 0) {
      out.push({ kind: 'text', value: acc })
      acc = ''
    }
    out.push({ kind: 'seq', value: m[0] })
    i = m.index + m[0].length
  }
  if (i < input.length) acc += input.slice(i)
  if (acc.length > 0) out.push({ kind: 'text', value: acc })
  return out
}

/** Compile only enabled + safely-compilable rules, sorted by priority asc. */
export function compileRules(rules: HighlightRule[]): CompiledRule[] {
  const out: CompiledRule[] = []
  for (const rule of rules) {
    if (!rule || rule.enabled === false) continue
    const pattern = rule.pattern
    if (typeof pattern !== 'string' || pattern.length === 0) continue
    let regex: RegExp
    try {
      // 'g' always; case-sensitivity left to the pattern (no automatic 'i').
      regex = new RegExp(pattern, 'g')
    } catch {
      continue // invalid pattern → silently skip
    }
    const fg = typeof rule.color?.fg === 'string' ? rule.color.fg : ''
    if (!/^#[0-9a-fA-F]{3}$|^#[0-9a-fA-F]{6}$/.test(fg)) continue
    const bg = typeof rule.color?.bg === 'string' ? rule.color.bg : undefined
    out.push({ id: rule.id, regex, fg, bg, priority: rule.priority })
  }
  out.sort((a, b) => a.priority - b.priority)
  return out
}

/** Wrap one plain-text span with truecolor SGR. */
function wrap(text: string, fgHex: string, bgHex?: string): string {
  const f = hexToRgb(fgHex)
  let s = `\x1b[38;2;${f.r};${f.g};${f.b}`
  if (bgHex) {
    const b = hexToRgb(bgHex)
    s += `;48;2;${b.r};${b.g};${b.b}`
  }
  return `${s}m${text}\x1b[0m`
}

/** True when [s,e) overlaps any claimed span. */
function overlaps(claimed: Span[], s: number, e: number): boolean {
  for (const c of claimed) {
    if (s < c.end && e > c.start) return true
  }
  return false
}

/**
 * Apply all rules to a single plain-text run. Consumes from `budgets` (per-rule
 * remaining match allowance shared across the whole chunk). Returns the
 * SGR-injected text. With a global budget of zero for every rule the run is
 * returned untouched.
 */
function applyRun(text: string, rules: CompiledRule[], budgets: number[]): string {
  if (text.length === 0) return ''
  const claimed: Span[] = []
  for (let ri = 0; ri < rules.length; ri++) {
    const rule = rules[ri]
    if (budgets[ri] <= 0) continue
    rule.regex.lastIndex = 0
    let m: RegExpExecArray | null
    let made = 0
    while ((m = rule.regex.exec(text)) !== null) {
      const start = m.index
      const end = start + m[0].length
      // guard against zero-width / runaway matches
      if (end <= start) {
        rule.regex.lastIndex++
        continue
      }
      if (!overlaps(claimed, start, end)) {
        claimed.push({ start, end, fg: rule.fg, bg: rule.bg })
        made++
        budgets[ri]--
        if (budgets[ri] <= 0) break
      }
      if (rule.regex.lastIndex === start) rule.regex.lastIndex++ // hard anti-recurse
    }
  }
  if (claimed.length === 0) return text
  claimed.sort((a, b) => a.start - b.start)
  let out = ''
  let pos = 0
  for (const c of claimed) {
    if (c.start > pos) out += text.slice(pos, c.start)
    out += wrap(text.slice(c.start, c.end), c.fg, c.bg)
    pos = c.end
  }
  if (pos < text.length) out += text.slice(pos)
  return out
}

/**
 * Rewrite `chunk` with truecolor highlights. Returns the input unchanged when
 * there are no enabled rules, the chunk is empty, or it exceeds the budget.
 */
export function applyHighlights(chunk: string, rules: CompiledRule[]): string {
  if (!chunk || rules.length === 0) return chunk
  if (chunk.length > MAX_CHUNK) return chunk

  let budgets = rules.map(() => MAX_PER_RULE)
  let usedBudget = false
  let out = ''
  for (const token of tokenize(chunk)) {
    if (token.kind === 'seq') {
      out += token.value
      continue
    }
    // Double insurance: a residual raw ESC that somehow survives tokenization is
    // never highlighted (it is a partial/unknown escape, do not corrupt it).
    if (token.value.includes('\x1b')) {
      out += token.value
      continue
    }
    const before = budgets.reduce((a, b) => a + b, 0)
    out += applyRun(token.value, rules, budgets)
    const after = budgets.reduce((a, b) => a + b, 0)
    if (after < before) usedBudget = true
  }
  return usedBudget ? out : chunk
}

/** True when `seg` is a dangling, unfinished escape fragment (must not be emitted). */
function isIncompleteEscape(seg: string): boolean {
  // `seg` is expected to start at (or be) a lone ESC.
  // A lone ESC — the leading half of any CSI/OSC/two-char/ST sequence.
  if (seg === '\x1b') return true
  // Unfinished CSI: ESC [ plus parameter bytes but no final byte in 0x40..0x7E.
  if (/^\x1b\[[0-9;:?]*$/.test(seg)) return true
  // Unfinished OSC: ESC ] ... with no BEL (\x07) or ST (\x1b\ ) terminator.
  // (A trailing half-ST is covered by the lone-ESC case above.)
  if (seg.startsWith('\x1b]') && !seg.includes('\x07') && !seg.includes('\x1b\\')) return true
  return false
}

/** Index of the last complete escape sequence's end in `input`, or -1. */
function lastEscapeEnd(input: string): number {
  let end = -1
  let m: RegExpExecArray | null
  ESCAPE_RE.lastIndex = 0
  while ((m = ESCAPE_RE.exec(input)) !== null) end = m.index + m[0].length
  return end
}

/** Index of the dangling incomplete escape at the tail of `input`, or -1. */
function findIncompleteIndex(input: string): number {
  const idx = input.lastIndexOf('\x1b')
  if (idx < 0) return -1
  return isIncompleteEscape(input.slice(idx)) ? idx : -1
}

/** Upper bound a held (unfinished) escape fragment is allowed to grow to. */
const MAX_CARRY = 1024

/**
 * Stateful, block-agnostic highlighter.
 *
 * PTY output arrives in arbitrary chunks: (a) escape sequences are routinely cut
 * mid-sequence, and (b) a plain-text run can span many chunks. To make the
 * streamed result identical to highlighting the whole stream at once (important
 * for `^`/`$`-anchored rules), `push` only emits a safe *closed* prefix and
 * holds back anything that a later chunk could continue:
 *   - a trailing *incomplete escape* (no final byte / OSC terminator), or
 *   - the final *text run* (it may extend into the next chunk).
 * Held bytes are re-joined with the next chunk before highlighting, so run /
 * anchor boundaries never shift. `flush` highlights whatever is still held.
 */
export class HighlightStream {
  private rules: CompiledRule[]
  private buffer = ''

  constructor(rules: CompiledRule[]) {
    this.rules = rules
  }

  /** Swap the active rules without touching any buffered content. */
  setRules(rules: CompiledRule[]): void {
    this.rules = rules
  }

  /** True while content is held back (a pending flush will release it). */
  hasPending(): boolean {
    return this.buffer.length > 0
  }

  /** Join held bytes with `chunk`, return content safe to hand to xterm. */
  push(chunk: string): string {
    this.buffer += chunk

    // (a) trailing incomplete escape -> hold it, emit the closed prefix.
    const incompleteAt = findIncompleteIndex(this.buffer)
    if (incompleteAt >= 0) {
      const head = this.buffer.slice(0, incompleteAt)
      const tail = this.buffer.slice(incompleteAt)
      if (tail.length > MAX_CARRY) {
        // Give up waiting on a pathologically long unterminated sequence: emit
        // the fragment raw (applyHighlights skips raw \x1b in text runs).
        this.buffer = ''
        return applyHighlights(head, this.rules) + tail
      }
      this.buffer = tail
      return applyHighlights(head, this.rules)
    }

    // (b) no incomplete escape -> find the last *closed* escape and emit only
    // through its end, holding the trailing text run for a future chunk.
    const lastEnd = lastEscapeEnd(this.buffer)
    if (lastEnd < 0) {
      // Pure text so far, nothing is closed yet. Bounds memory: if it grew past
      // the per-chunk budget just pass it through raw rather than hold forever.
      if (this.buffer.length > MAX_CHUNK) {
        const raw = this.buffer
        this.buffer = ''
        return applyHighlights(raw, this.rules)
      }
      return ''
    }
    const head = this.buffer.slice(0, lastEnd)
    this.buffer = this.buffer.slice(lastEnd)
    return applyHighlights(head, this.rules)
  }

  /** Flush any held content (session end) — highlighted as a final run. */
  flush(): string {
    const b = this.buffer
    this.buffer = ''
    return applyHighlights(b, this.rules)
  }
}

/** Exposed for self-tests only — not part of the public contract. */
export const __testHooks = { tokenize, hexToRgb, isIncompleteEscape, findIncompleteIndex, lastEscapeEnd }