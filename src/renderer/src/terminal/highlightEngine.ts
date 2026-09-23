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
  /** compiled with the 'g' flag (plus 'i' for case-insensitive rules) */
  regex: RegExp
  /** hex fg, e.g. "#3fb950" — converted to rgb only at wrap time */
  fg: string
  /** optional hex bg */
  bg?: string
  /** optional value bands, ascending by `min` — see HighlightRule.bands */
  bands?: { min: number; fg: string }[]
  /** copied from the source rule for stable priority ordering */
  priority: number
}

/** Per-rule counters, only filled when a stats sink is passed in (see `StatsSink`). */
export interface RuleStat {
  /** matches that were actually coloured */
  hits: number
  /** wall time spent scanning with this rule, milliseconds */
  ms: number
}

/**
 * Optional sink for the settings page's stats view. Absent on the default path,
 * so an ordinary terminal write pays nothing for the counters.
 */
export type StatsSink = Map<string, RuleStat>

type Token = { kind: 'seq' | 'text'; value: string }
type Span = { start: number; end: number; fg: string; bg?: string }

/** ANSI escape tokens: CSI, OSC, two-char (ESC ( / ) ..), and ESC = / > . */
const ESCAPE_RE =
  /(\x1b\[[0-9;:?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-B]|\x1b[=>])/g

/** Matches a single rule may inject per chunk (bomb guard). */
const MAX_PER_RULE = 300
/** Chunks larger than this are returned unmodified (budget guard). */
const MAX_CHUNK = 512 * 1024
/**
 * Longest newline-free segment of a plain-text run a user rule is applied to.
 * MAX_PER_RULE bounds the match *count*, not a pattern's backtracking *cost*:
 * a pathological pattern like `(a+)+b` walks the whole line before the count
 * can stop it, which freezes the renderer on one very long line. A run holding
 * such a line is passed through unhighlighted — ordinary output (many short
 * lines, whatever the chunk size) is unaffected, since the bound is per line,
 * not per run.
 */
const MAX_LINE_LEN = 4 * 1024

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
      // 'g' always; 'i' when the rule asks for case-insensitive matching.
      // Lookbehinds (used by the preset success rule to leave `not ok` alone)
      // need no special handling — they are plain V8 regex syntax.
      regex = new RegExp(pattern, rule.caseInsensitive === true ? 'gi' : 'g')
    } catch {
      continue // invalid pattern → silently skip
    }
    const fg = typeof rule.color?.fg === 'string' ? rule.color.fg : ''
    if (!/^#[0-9a-fA-F]{3}$|^#[0-9a-fA-F]{6}$/.test(fg)) continue
    const bg = typeof rule.color?.bg === 'string' ? rule.color.bg : undefined
    out.push({ id: rule.id, regex, fg, bg, bands: compileBands(rule.bands), priority: rule.priority })
  }
  out.sort((a, b) => a.priority - b.priority)
  return out
}

/** Keep only well-formed value bands, ascending — the engine walks them in order. */
function compileBands(bands: HighlightRule['bands']): CompiledRule['bands'] {
  if (!Array.isArray(bands)) return undefined
  const kept: { min: number; fg: string }[] = []
  for (const band of bands) {
    if (!band || !Number.isFinite(band.min)) continue
    if (typeof band.fg !== 'string' || !/^#[0-9a-fA-F]{3}$|^#[0-9a-fA-F]{6}$/.test(band.fg)) continue
    kept.push({ min: band.min, fg: band.fg })
  }
  if (kept.length === 0) return undefined
  kept.sort((a, b) => a.min - b.min)
  return kept
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
 * Colour for one match: with value bands the match's first number picks the
 * band (last `min` that is <= the value wins); everything else keeps the rule's
 * own foreground.
 */
function bandColor(rule: CompiledRule, matched: string): string {
  const bands = rule.bands
  if (!bands || bands.length === 0) return rule.fg
  const number = /-?\d+(?:\.\d+)?/.exec(matched)
  if (number === null) return rule.fg
  const value = Number(number[0])
  if (!Number.isFinite(value)) return rule.fg
  let fg = rule.fg
  for (const band of bands) {
    if (value < band.min) break
    fg = band.fg
  }
  return fg
}

/** True when `text` holds a newline-free segment longer than MAX_LINE_LEN. */
function hasLongLine(text: string): boolean {
  let start = 0
  for (;;) {
    const nl = text.indexOf('\n', start)
    if (nl < 0) return text.length - start > MAX_LINE_LEN
    if (nl - start > MAX_LINE_LEN) return true
    start = nl + 1
  }
}

/**
 * Apply all rules to a single plain-text run. Consumes from `budgets` (per-rule
 * remaining match allowance shared across the whole chunk). Returns the
 * SGR-injected text. With a global budget of zero for every rule the run is
 * returned untouched, as is a run holding an over-long line (see MAX_LINE_LEN).
 */
/** Millisecond clock for the optional stats sink; `performance` when present. */
const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now())

function applyRun(text: string, rules: CompiledRule[], budgets: number[], stats?: StatsSink): string {
  if (text.length === 0) return ''
  if (hasLongLine(text)) return text
  const claimed: Span[] = []
  for (let ri = 0; ri < rules.length; ri++) {
    const rule = rules[ri]
    if (budgets[ri] <= 0) continue
    const started = stats === undefined ? 0 : now()
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
        claimed.push({ start, end, fg: bandColor(rule, m[0]), bg: rule.bg })
        made++
        budgets[ri]--
        if (budgets[ri] <= 0) break
      }
      if (rule.regex.lastIndex === start) rule.regex.lastIndex++ // hard anti-recurse
    }
    if (stats !== undefined) {
      const stat = stats.get(rule.id) ?? { hits: 0, ms: 0 }
      stat.hits += made
      stat.ms += now() - started
      stats.set(rule.id, stat)
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
 * With a `stats` sink attached, per-rule hit counts and scan times are added to
 * it — the settings page's stats view is the only caller that passes one.
 */
export function applyHighlights(chunk: string, rules: CompiledRule[], stats?: StatsSink): string {
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
    out += applyRun(token.value, rules, budgets, stats)
    const after = budgets.reduce((a, b) => a + b, 0)
    if (after < before) usedBudget = true
  }
  return usedBudget ? out : chunk
}

/** One coloured or plain segment of a preview line. */
export interface PreviewSpan {
  text: string
  fg?: string
  bg?: string
}

/** "#rrggbb" from three decimal SGR colour components. */
function toHex(r: string, g: string, b: string): string {
  const part = (value: string): string => Number(value).toString(16).padStart(2, '0')
  return `#${part(r)}${part(g)}${part(b)}`
}

/**
 * Split `text` into coloured and plain segments for the settings preview.
 *
 * It runs the real highlighter and parses its own SGR output instead of
 * re-implementing the matching, so the editor preview cannot drift from what the
 * terminal actually receives. Escape sequences already in the sample are
 * stripped first: this shows text the user typed, not a captured stream.
 */
export function previewSpans(text: string, rules: CompiledRule[]): PreviewSpan[] {
  const out = applyHighlights(text.replace(ESCAPE_RE, ''), rules)
  const spans: PreviewSpan[] = []
  const SGR = /\x1b\[38;2;(\d+);(\d+);(\d+)(?:;48;2;(\d+);(\d+);(\d+))?m([\s\S]*?)\x1b\[0m/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = SGR.exec(out)) !== null) {
    if (m.index > last) spans.push({ text: out.slice(last, m.index) })
    spans.push({
      text: m[7],
      fg: toHex(m[1], m[2], m[3]),
      ...(m[4] !== undefined ? { bg: toHex(m[4], m[5], m[6]) } : {})
    })
    last = m.index + m[0].length
  }
  if (last < out.length) spans.push({ text: out.slice(last) })
  return spans
}

/** True when `seg` is a dangling, unfinished escape fragment (must not be emitted). */function isIncompleteEscape(seg: string): boolean {
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
  private stats?: StatsSink
  private buffer = ''

  constructor(rules: CompiledRule[]) {
    this.rules = rules
  }

  /** Swap the active rules without touching any buffered content. */
  setRules(rules: CompiledRule[]): void {
    this.rules = rules
  }

  /** Attach or drop the optional stats sink (see `highlightStats`). */
  setStats(stats: StatsSink | undefined): void {
    this.stats = stats
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
        return applyHighlights(head, this.rules, this.stats) + tail
      }
      this.buffer = tail
      return applyHighlights(head, this.rules, this.stats)
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
        return applyHighlights(raw, this.rules, this.stats)
      }
      return ''
    }
    const head = this.buffer.slice(0, lastEnd)
    this.buffer = this.buffer.slice(lastEnd)
    return applyHighlights(head, this.rules, this.stats)
  }

  /** Flush any held content (session end) — highlighted as a final run. */
  flush(): string {
    const b = this.buffer
    this.buffer = ''
    return applyHighlights(b, this.rules, this.stats)
  }
}

/** Exposed for self-tests only — not part of the public contract. */
export const __testHooks = { tokenize, hexToRgb, isIncompleteEscape, findIncompleteIndex, lastEscapeEnd }