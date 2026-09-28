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
  /** hex fg, e.g. "#3fb950" — kept for introspection; `open` is precomputed from it */
  fg: string
  /** optional hex bg (not re-validated; a malformed value folds to white, as before) */
  bg?: string
  /** optional value bands, ascending by `min` — see HighlightRule.bands */
  bands?: { min: number; fg: string; open: string }[]
  /** copied from the source rule for stable priority ordering */
  priority: number
  /** precomputed truecolor fg fragment, e.g. "38;2;63;185;80" */
  fgSgr: string
  /** full SGR open sequence `\x1b[38;2;…(;48;2;…)?m` incl. optional bg, built once here */
  open: string
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
/** A claimed span carries its precomputed SGR open sequence, never a hex colour. */
type Span = { start: number; end: number; open: string }

/**
 * ANSI escape tokens:
 *  - CSI            `ESC [ … final`
 *  - OSC            `ESC ] … (BEL | ST)`
 *  - DCS/APC/PM/SOS `ESC P|X|^|_ … (BEL | ST)` — tmux, sixel, kitty graphics.
 *    The `[^\x1b]*` body means an unterminated one stops at the next ESC
 *    instead of swallowing the rest of the buffer (it then stays a text run,
 *    which applyHighlights passes through raw).
 *  - two-char charset `ESC ( x` / `ESC ) x`, keypad modes `ESC =` / `ESC >`
 *  - single-char Fe escapes: `ESC` + one 0x30–0x7E byte (DECSC `\x1b7`,
 *    DECRC `\x1b8`, NEL `\x1bE`, RI `\x1bM`, RIS `\x1bc`, orphan ST `\x1b\`, …).
 *    Last in the alternation, and the initiators of the longer forms
 *    (`[ ] ( ) P X ^ _ = >`) are excluded from the class so it can never steal
 *    the leading bytes of a longer sequence.
 */
const ESCAPE_RE =
  /(\x1b\[[0-9;:?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-B]|\x1b[=>]|\x1b[0-9:;<?@A-OQ-WYZ\\`a-z{|}~])/g

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

/** "r;g;b" decimal SGR fragment for one hex colour (white fallback via hexToRgb). */
function rgbFragment(hex: string): string {
  const { r, g, b } = hexToRgb(hex)
  return `${r};${g};${b}`
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
    // bg stays unvalidated on purpose (as before): a malformed hex folds to
    // white inside hexToRgb, byte-identical to the old wrap-time conversion.
    const bgPart = bg ? `;48;2;${rgbFragment(bg)}` : ''
    const fgSgr = rgbFragment(fg)
    out.push({
      id: rule.id,
      regex,
      fg,
      bg,
      bands: compileBands(rule.bands, bgPart),
      priority: rule.priority,
      fgSgr,
      open: `\x1b[38;2;${fgSgr}${bgPart}m`
    })
  }
  out.sort((a, b) => a.priority - b.priority)
  return out
}

/** Keep only well-formed value bands, ascending — the engine walks them in order. */
function compileBands(bands: HighlightRule['bands'], bgPart: string): CompiledRule['bands'] {
  if (!Array.isArray(bands)) return undefined
  const kept: NonNullable<CompiledRule['bands']> = []
  for (const band of bands) {
    if (!band || !Number.isFinite(band.min)) continue
    if (typeof band.fg !== 'string' || !/^#[0-9a-fA-F]{3}$|^#[0-9a-fA-F]{6}$/.test(band.fg)) continue
    kept.push({ min: band.min, fg: band.fg, open: `\x1b[38;2;${rgbFragment(band.fg)}${bgPart}m` })
  }
  if (kept.length === 0) return undefined
  kept.sort((a, b) => a.min - b.min)
  return kept
}

/** Wrap one plain-text span with its precomputed SGR open sequence. */
function wrap(text: string, open: string): string {
  return `${open}${text}\x1b[0m`
}

/**
 * Try to claim [s,e) for a span. Claimed spans are pairwise disjoint and kept
 * sorted by start (ends ascend with starts), which turns the old linear scan
 * over every claimed span (O(spans²) on match-dense runs) into:
 *  - an O(1) append when the candidate lands past every claim — the common
 *    case, since rule scans sweep a run left to right; otherwise
 *  - one binary search: the only possible clash is with the nearest span left
 *    of the insertion point.
 * The span colour is only computed on accept. Returns true when claimed.
 */
function claim(claimed: Span[], s: number, e: number, rule: CompiledRule, matched: string): boolean {
  const n = claimed.length
  if (n === 0 || claimed[n - 1].end <= s) {
    claimed.push({ start: s, end: e, open: bandOpen(rule, matched) })
    return true
  }
  let lo = 0
  let hi = n
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (claimed[mid].start < e) lo = mid + 1
    else hi = mid
  }
  if (lo > 0 && claimed[lo - 1].end > s) return false
  claimed.splice(lo, 0, { start: s, end: e, open: bandOpen(rule, matched) })
  return true
}

/** First-number finder for band selection; no /g, so the shared literal is stateless. */
const BAND_NUMBER_RE = /-?\d+(?:\.\d+)?/

/**
 * SGR open sequence for one match: with value bands the match's first number
 * picks the band (last `min` that is <= the value wins); everything else keeps
 * the rule's own precomputed open sequence. Pure table lookup — no colour math
 * on the hot path.
 */
function bandOpen(rule: CompiledRule, matched: string): string {
  const bands = rule.bands
  if (!bands || bands.length === 0) return rule.open
  const number = BAND_NUMBER_RE.exec(matched)
  if (number === null) return rule.open
  const value = Number(number[0])
  if (!Number.isFinite(value)) return rule.open
  let open = rule.open
  for (const band of bands) {
    if (value < band.min) break
    open = band.open
  }
  return open
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

function applyRun(text: string, rules: CompiledRule[], budgets: number[], stats?: StatsSink, spent?: { n: number }): string {
  if (text.length === 0) {
    if (spent !== undefined) spent.n = 0
    return ''
  }
  if (hasLongLine(text)) {
    if (spent !== undefined) spent.n = 0
    return text
  }
  const claimed: Span[] = []
  let totalMade = 0
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
      if (claim(claimed, start, end, rule, m[0])) {
        made++
        totalMade++
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
  if (spent !== undefined) spent.n = totalMade
  if (claimed.length === 0) return text
  // `claim` keeps the spans sorted by start — no final sort needed here.
  let out = ''
  let pos = 0
  for (const c of claimed) {
    if (c.start > pos) out += text.slice(pos, c.start)
    out += wrap(text.slice(c.start, c.end), c.open)
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
  // applyRun reports how many matches it claimed, replacing the old two
  // budgets.reduce() passes per text token.
  const spent = { n: 0 }
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
    spent.n = 0
    out += applyRun(token.value, rules, budgets, stats, spent)
    if (spent.n > 0) usedBudget = true
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

/**
 * True when `seg` is a dangling, unfinished escape fragment (must not be
 * emitted before its terminator arrives).
 */
function isIncompleteEscape(seg: string): boolean {
  // `seg` is expected to start at (or be) a lone ESC.
  // A lone ESC — the leading half of any CSI/OSC/DCS/two-char/ST/Fe sequence.
  if (seg === '\x1b') return true
  // Unfinished CSI: ESC [ plus parameter bytes but no final byte in 0x40..0x7E.
  if (/^\x1b\[[0-9;:?]*$/.test(seg)) return true
  // Unfinished OSC / DCS / APC / PM / SOS: opened but no BEL (\x07) or ST
  // (\x1b\) terminator yet, so the fragment could still grow into any of them.
  // (A trailing half-ST — the ESC of `\x1b\` with the `\` still to come — is
  // covered by the lone-ESC case above, since findIncompleteIndex slices from
  // the *last* ESC.)
  // NB: `[]` would be an *empty* class in JS regex, so `]` is kept in a
  // startsWith instead of a merged character class.
  if (
    (seg.startsWith('\x1b]') || /^\x1b[PX^_]/.test(seg)) &&
    !seg.includes('\x07') &&
    !seg.includes('\x1b\\')
  ) {
    return true
  }
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
  /** Whether `buffer` holds any ESC — lets push skip the O(buffer) escape scans on escape-free floods. */
  private bufferHasEsc = false

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
    // Fast path: neither the held text nor the new chunk contains a single ESC,
    // so findIncompleteIndex/lastEscapeEnd would both come back -1. Skip their
    // O(buffer) rescans — they made escape-free floods (cat of a large text
    // file) quadratic in the held buffer — and go straight to the trailing-text
    // hold. Decision-identical to the full path below.
    if (!this.bufferHasEsc && !chunk.includes('\x1b')) {
      this.buffer += chunk
      if (this.buffer.length > MAX_CHUNK) {
        const raw = this.buffer
        this.buffer = ''
        return applyHighlights(raw, this.rules, this.stats)
      }
      return ''
    }
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
        this.bufferHasEsc = false
        return applyHighlights(head, this.rules, this.stats) + tail
      }
      this.buffer = tail
      this.bufferHasEsc = true // the held tail starts at the dangling ESC
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
        this.bufferHasEsc = false
        return applyHighlights(raw, this.rules, this.stats)
      }
      // The buffer (or the chunk that just joined it) brought the ESC in.
      this.bufferHasEsc = true
      return ''
    }
    const head = this.buffer.slice(0, lastEnd)
    this.buffer = this.buffer.slice(lastEnd)
    this.bufferHasEsc = this.buffer.includes('\x1b')
    return applyHighlights(head, this.rules, this.stats)
  }

  /** Flush any held content (session end) — highlighted as a final run. */
  flush(): string {
    const b = this.buffer
    this.buffer = ''
    this.bufferHasEsc = false
    return applyHighlights(b, this.rules, this.stats)
  }
}

/** Exposed for self-tests only — not part of the public contract. */
export const __testHooks = { tokenize, hexToRgb, isIncompleteEscape, findIncompleteIndex, lastEscapeEnd }