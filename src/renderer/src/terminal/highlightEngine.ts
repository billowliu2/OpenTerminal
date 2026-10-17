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
  /** compiled with the 'g' flag (plus 'i'/'m' when the rule asks for them) */
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

/**
 * Optional outlet for *match events*: called once per span the engine actually
 * paints, with the owning rule's id and the matched text.
 *
 * "Actually paints" is the whole contract — a match another rule claimed first,
 * one dropped by the per-rule budget, and a line skipped for being over
 * MAX_LINE_LEN all report nothing, so a consumer never sees a hit that is not
 * visible on screen. `text` is the raw matched substring: consumers that show
 * something to the user must not render it (for the secret rule it *is* the
 * secret); it is there for consumers that only need a shape or a length.
 *
 * Undefined on the default path: the engine skips the call entirely.
 */
export type MatchListener = (ruleId: string, text: string) => void

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
  /(\x1b\[[0-9;:?<>=]*[ -/]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-B]|\x1b[=>]|\x1b[0-9:;<?@A-OQ-WYZ\\`a-z{|}~])/g

/** Matches a single rule may inject per chunk (bomb guard). */
const MAX_PER_RULE = 300
/** Chunks larger than this are returned unmodified (budget guard). */
const MAX_CHUNK = 512 * 1024
/**
 * Longest line a user rule is applied to.
 * MAX_PER_RULE bounds the match *count*, not a pattern's backtracking *cost*:
 * a pathological pattern like `(a+)+b` walks the whole line before the count
 * can stop it, which freezes the renderer on one very long line. Ordinary
 * output (many short lines, whatever the chunk size) is unaffected, since the
 * bound is per line, not per run.
 *
 * A run whose lines are all short is scanned whole, which is what lets rules
 * match across a newline (`\\n/tmp` for the path rule, `^`-anchored presets at
 * every line start). Only when the run holds an over-long line does `applyRun`
 * degrade to line-at-a-time scanning: each short line is still scanned, the
 * over-long one is passed through raw, and cross-line matches are given up for
 * that run alone — one base64 blob or minified JSON no longer costs the rest
 * of the run its highlighting.
 */
const MAX_LINE_LEN = 4 * 1024

/**
 * Longest user pattern accepted. Bounds the damage a stored rule can do and
 * keeps the editor's live preview from choking on a paste.
 */
export const MAX_PATTERN_LEN = 500

/**
 * Advisory ReDoS heuristic for the rule EDITOR: flags patterns whose shape
 * admits exponential backtracking.
 *
 * Scope is deliberately limited to a warning. Measured misses — `[(](a+)+`
 * (4s on 30 chars) and `(?:a|a)+` (7.5s) / `((a|a))+` (16s) both slip through —
 * mean it must NOT gate the hot path: rejecting on a heuristic would silently
 * disable legitimate rules while still letting hostile ones past. It is useful
 * where a false negative costs nothing and a hit saves the user from typing a
 * pattern that would freeze the settings page.
 *
 * Why not the two obvious alternatives, both measured:
 *  - `re2` fixes it at the root but does not support lookbehind, and `perm`,
 *    `okstate` and `http` presets depend on it — the cure breaks the feature.
 *  - A Worker with a timeout is reliable (6/6 dangerous caught, main thread
 *    responsive) but costs ~0.11ms per round trip versus ~0.035ms direct, and
 *    terminal highlighting must stay synchronous because `WriteBatcher`
 *    consumes the coloured text inline. It remains the right tool for rule
 *    VALIDATION (low frequency, may be async) — just not for the hot path.
 *
 * Runtime cut-offs cannot help either: one `exec` on a catastrophic pattern
 * blocks for 28s, so a clock check inside the match loop never gets to run.
 */
export function isReDoSProne(pattern: string): boolean {
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] !== '(' || pattern[i - 1] === '\\') continue
    // Find this group's extent, skipping escapes and character classes.
    let depth = 0
    let j = i
    for (; j < pattern.length; j++) {
      const c = pattern[j]
      if (c === '\\') {
        j++
        continue
      }
      if (c === '[') {
        while (j < pattern.length && pattern[j] !== ']') {
          if (pattern[j] === '\\') j++
          j++
        }
        continue
      }
      if (c === '(') depth++
      else if (c === ')') {
        depth--
        if (!depth) break
      }
    }
    if (j >= pattern.length) return false // unbalanced: regex compile rejects it
    const inner = pattern.slice(i + 1, j)
    const after = pattern.slice(j + 1)
    // `(?=`, `(?!`, `(?<=`, `(?<!` groups are assertions — no quantifier applies.
    if (/^\?<?[=!]/.test(inner)) continue
    const outerQuantified = /^[*+]/.test(after) || /^\{\d+,?\d*\}/.test(after)
    if (!outerQuantified) continue
    // A bounded outer quantifier (`{3}`, `{1,5}`) repeats a fixed number of
    // times, so it cannot backtrack exponentially — `(?:\d{1,3}\.){3}` in the
    // ipv4 preset is perfectly safe. Only `*`, `+` and open-ended `{n,}` are.
    const bounded = /^\{\d+\}/.test(after) || /^\{\d+,\d+\}/.test(after)
    if (bounded) continue
    if (hasInnerQuantifier(inner)) return true
    const branches = splitTopLevelAlternation(inner)
    if (branches.length > 1 && new Set(branches).size < branches.length) return true
  }
  return false
}

/** True when a group body contains its own quantifier (outside classes/escapes). */
function hasInnerQuantifier(inner: string): boolean {
  let inClass = false
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]
    if (c === '\\') {
      i++
      continue
    }
    if (c === '[') {
      inClass = true
      continue
    }
    if (c === ']') {
      inClass = false
      continue
    }
    if (inClass) continue
    if (c === '*' || c === '+') return true
    if (c === '{' && /^\{\d+,?\d*\}/.test(inner.slice(i))) return true
  }
  return false
}

/** Split on `|` at nesting depth 0, ignoring escaped and in-class pipes. */
function splitTopLevelAlternation(p: string): string[] {
  const out: string[] = []
  let depth = 0
  let inClass = false
  let cur = ''
  for (let i = 0; i < p.length; i++) {
    const c = p[i]
    if (c === '\\') {
      cur += c + (p[i + 1] ?? '')
      i++
      continue
    }
    if (c === '[') {
      inClass = true
      cur += c
      continue
    }
    if (c === ']') {
      inClass = false
      cur += c
      continue
    }
    if (inClass) {
      cur += c
      continue
    }
    if (c === '(') depth++
    if (c === ')') depth--
    if (c === '|' && depth === 0) {
      out.push(cur)
      cur = ''
      continue
    }
    cur += c
  }
  out.push(cur)
  return out
}

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

/** Flags a rule compiles with: global, plus `i` / `m` when the rule opts in. */
function flagsFor(rule: HighlightRule): string {
  return `g${rule.caseInsensitive === true ? 'i' : ''}${rule.lineAnchor === true ? 'm' : ''}`
}

/** Compile only enabled + safely-compilable rules, sorted by priority asc. */
export function compileRules(rules: HighlightRule[]): CompiledRule[] {
  const out: CompiledRule[] = []
  for (const rule of rules) {
    if (!rule || rule.enabled === false) continue
    const pattern = rule.pattern
    if (typeof pattern !== 'string' || pattern.length === 0) continue
    // Bounded like the other per-rule guards: a huge pattern only costs compile
    // time, but it also means someone pasted a blob into the editor.
    if (pattern.length > MAX_PATTERN_LEN) continue
    // NOTE: the rule is deliberately NOT rejected for a ReDoS-prone shape here.
    // `isReDoSProne` is an advisory heuristic used by the editor only — it has
    // measured misses (`[(](a+)+`, `(?:a|a)+`) and false positives, so using it
    // as a gate would silently disable legitimate rules while still letting
    // some hostile ones through. The real bounds on this path remain
    // MAX_LINE_LEN (no line over 4KB reaches a user regex) and MAX_PER_RULE.
    let regex: RegExp
    try {
      // 'g' always; 'i' when the rule asks for case-insensitive matching; 'm'
      // when it asks for per-line anchoring, so `^ERROR$` fires on each line of
      // a multi-line run instead of only on the run's first/last line.
      // Lookbehinds (used by the preset success rule to leave `not ok` alone)
      // need no special handling — they are plain V8 regex syntax.
      regex = new RegExp(pattern, flagsFor(rule))
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

/**
 * SGR sequences replayed after a highlight span, so the span never disturbs the
 * colours the *application* had active when it emitted the text.
 *
 * `wrap` closes a span with a reset; without a restore that reset also wipes
 * whatever SGR the application set earlier in the stream, so
 * `\x1b[33mWARNING tail` came back with `tail` in the default colour instead of
 * the application's yellow. A CSI is only replayed when its final byte is `m`
 * (SGR): cursor moves, OSC titles and the rest are state from another axis and
 * replaying them would move the cursor or reset the title a second time.
 */
const SGR_ONLY_RE = /\x1b\[[0-9:;<=>?]*m/g

/**
 * Cap on the accumulated restore string. Applications that repaint every cell
 * emit thousands of SGRs between resets; replaying all of them after *every*
 * span would multiply the chunk size by the span count. Past the cap the
 * restore is dropped (plain reset), which is the pre-fix behaviour — bounded
 * output matters more than an exact colour in that extreme.
 */
const MAX_RESTORE_LEN = 256

/**
 * Replay budget per span, counted in SEQUENCES rather than bytes. The restore
 * string is repeated for EVERY span in the run, so its real cost is
 * (state size x spans): on Kimi-style TUI output (~19 spans/line) an unbounded
 * restore inflated a 9.5KB chunk to 40.8KB (4.30x, vs 2.78x without it), and the
 * renderer froze for 18.4s. Bytes are the wrong unit though — one foreground
 * colour is `ESC[31m` (5B), `ESC[38;5;196m` (11B) or `ESC[38;2;r;g;bm` (up to
 * 19B), so a byte cap silently kept indexed colours working while dropping
 * truecolor. Counting sequences treats those three identically: replay the
 * state when it is a couple of attributes, drop it when the application is
 * stacking a whole paint job per cell.
 */
const MAX_REPLAY_SEQUENCES = 3

/**
 * The application's active SGR state: every `…m` CSI emitted since the last
 * reset, concatenated in order (`''` when the application has set none).
 *
 * It is tracked by `applyHighlights` and, crucially, *shared across chunks* by
 * `HighlightStream`: a push that ends mid-stream leaves the colours set by
 * earlier pushes in force for the next one, exactly as the terminal sees them.
 * Without that, streamed output would only restore the colours set inside the
 * same chunk and split-vs-whole output would diverge.
 */
class SgrState {
  private value = ''
  private count = 0

  /** SGR state on entering the next text run (see `wrap`). Empty when the
   *  accumulated chain is too long to replay profitably: every span would pay
   *  for it, and a per-cell repainting TUI emits dozens of spans per line. */
  get restore(): string {
    return this.count > 0 && this.count <= MAX_REPLAY_SEQUENCES ? this.value : ''
  }

  /** Fold one escape-sequence token in; non-SGR tokens leave the state alone. */
  absorb(token: string): void {
    if (!token.endsWith('m') || token.charCodeAt(0) !== 0x1b) return
    // A reset is any SGR whose parameters are all zero or empty — ECMA-48 says
    // `ESC[m`, `ESC[0m`, `ESC[00m`, `ESC[0;0m` and friends all mean "reset
    // everything". Matching only the two canonical spellings let the others be
    // *appended* to the accumulator instead of clearing it, so the state grew a
    // few bytes per line until it blew MAX_RESTORE_LEN and every later span lost
    // its restore. `ESC[0;32m` (a reset plus a colour, common in Go/Java log
    // libraries) must clear the state first and then record the new colour.
    SGR_ONLY_RE.lastIndex = 0
    let m: RegExpExecArray | null
    // A token may hold several sequences; only the SGR ones are replayed.
    while ((m = SGR_ONLY_RE.exec(token)) !== null) {
      const seq = m[0]
      const params = seq.slice(2, -1)
      const resets = params === '' || /^[0;:]*$/.test(params)
      if (resets) {
        this.value = ''
        this.count = 0
        continue
      }
      // `ESC[0;32m` starts with a reset parameter: drop what came before it.
      const afterReset = /^0+[;:](.*)$/.exec(params)
      if (afterReset) {
        this.value = ''
        this.count = 0
      }
      this.value += seq
      this.count += 1
      if (this.value.length > MAX_RESTORE_LEN) {
        // Too much state to replay economically: fall back to a plain reset
        // rather than inflating every span by hundreds of bytes. Per-cell
        // repainters (TUI frames) hit this constantly, and repeating the whole
        // chain after each span multiplies chunk size by the span count.
        this.value = ''
        this.count = 0
        return
      }
    }
  }
}

/**
 * Wrap one plain-text span in its precomputed SGR open sequence.
 * `restore` is the application's SGR state on entering the run ('' when it had
 * none), replayed after the reset so the span leaves the screen as it found it.
 */
function wrap(text: string, open: string, restore: string): string {
  return `${open}${text}${restore === '' ? '\x1b[0m' : `\x1b[0m${restore}`}`
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

/** Millisecond clock for the optional stats sink; `performance` when present. */
const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now())

/**
 * Apply all rules to a single plain-text run. Consumes from `budgets` (per-rule
 * remaining match allowance shared across the whole chunk). Returns the
 * SGR-injected text.
 *
 * Two layers:
 *  - every line short (the normal case): the whole run is scanned in one pass,
 *    so a rule can match across a newline — untouched from before.
 *  - any line over MAX_LINE_LEN: degrade to scanning line by line, so the
 *    over-long line alone goes through raw while its short neighbours still
 *    highlight. Cross-line matches are given up for that run, which is the
 *    price of never handing a >4KB line to a user pattern.
 */
function applyRun(
  text: string,
  rules: CompiledRule[],
  budgets: number[],
  restore: string,
  stats?: StatsSink,
  spent?: { n: number },
  onMatch?: MatchListener
): string {
  if (text.length === 0) {
    if (spent !== undefined) spent.n = 0
    return ''
  }
  if (!hasLongLine(text)) return applyShortRun(text, rules, budgets, restore, stats, spent, onMatch)

  let made = 0
  let out = ''
  // `\n` slices exactly, so joining the parts back reproduces the run byte for
  // byte whatever happens to each line.
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) out += '\n'
    const line = lines[i]
    if (line.length > MAX_LINE_LEN) {
      out += line // too long to hand to a user pattern — passed through raw
      continue
    }
    const runSpent = { n: 0 }
    out += applyShortRun(line, rules, budgets, restore, stats, runSpent, onMatch)
    made += runSpent.n
  }
  if (spent !== undefined) spent.n = made
  return out
}

/**
 * Scan one run that is known to be free of over-long lines. `restore` is the
 * application's SGR state on entering the run (see `wrap`).
 */
function applyShortRun(
  text: string,
  rules: CompiledRule[],
  budgets: number[],
  restore: string,
  stats?: StatsSink,
  spent?: { n: number },
  onMatch?: MatchListener
): string {
  if (text.length === 0) {
    if (spent !== undefined) spent.n = 0
    return ''
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
        // Report only what will actually paint: `claim` returning true is the
        // single point where a span becomes visible, so a stolen span, an
        // exhausted budget and a skipped over-long line all stay silent here.
        if (onMatch !== undefined) onMatch(rule.id, m[0])
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
  //
  // `restore` is paid per span and its cost is the whole point of the budget:
  // on a dense TUI line (Kimi emits ~19 spans/line) replaying it after every
  // span inflated a 9.5KB chunk to 40.8KB (4.30x vs 2.78x), which froze the
  // renderer for 18.4s. Two rules keep the colour where it is visible and skip
  // it where it is not:
  //   - after the LAST span it always pays (that text runs to the next escape),
  //   - between spans it only pays when the gap is worth seeing — a gap of a
  //     space or two between two coloured words reads as separation either way.
  // Gaps are measured on visible characters, and a long one (a mostly-plain line
  // with a couple of matches) gets its colour back.
  const MIN_GAP_FOR_RESTORE = 3
  let out = ''
  let pos = 0
  const last = claimed.length - 1
  for (let i = 0; i <= last; i++) {
    const c = claimed[i]
    if (c.start > pos) {
      const gap = text.slice(pos, c.start)
      // The gap between two spans carries the application's colour only if the
      // previous span restored it. Restoring is worth it for a visible gap (a
      // mostly-plain line with a couple of matches); a one- or two-character gap
      // between two coloured words reads the same either way, and skipping it
      // keeps dense TUI lines from being inflated span-by-span.
      const restoreGap = i > 0 && gap.length >= MIN_GAP_FOR_RESTORE
      out += restoreGap ? `${restore}${gap}` : gap
    }
    out += wrap(text.slice(c.start, c.end), c.open, i === last ? restore : '')
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
 *
 * `sgr` carries the application's SGR state. It is optional: a one-shot caller
 * (the settings preview) leaves it out and starts from "nothing set", while
 * `HighlightStream` threads one instance through every chunk so a colour set in
 * an earlier chunk is still restored in a later one.
 *
 * `onMatch` (see `MatchListener`) is the match-event outlet. Undefined on the
 * default path — the check happens once inside the scan loop, per claimed span,
 * so a caller that does not ask for events pays one `!== undefined` test per
 * coloured span and nothing else. No de-duplication or rate limiting happens
 * here: a rule that matched 200 times reports 200 times, and pacing is the
 * consumer's business.
 */
export function applyHighlights(
  chunk: string,
  rules: CompiledRule[],
  stats?: StatsSink,
  sgr: SgrState = new SgrState(),
  onMatch?: MatchListener
): string {
  if (!chunk || rules.length === 0) return chunk
  if (chunk.length > MAX_CHUNK) return chunk

  const budgets = rules.map(() => MAX_PER_RULE)
  let usedBudget = false
  let out = ''
  // applyRun reports how many matches it claimed, replacing the old two
  // budgets.reduce() passes per text token.
  const spent = { n: 0 }
  for (const token of tokenize(chunk)) {
    if (token.kind === 'seq') {
      out += token.value
      sgr.absorb(token.value)
      continue
    }
    // Double insurance: a residual raw ESC that somehow survives tokenization is
    // never highlighted (it is a partial/unknown escape, do not corrupt it).
    if (token.value.includes('\x1b')) {
      out += token.value
      continue
    }
    spent.n = 0
    // The state is read per run: a run's spans restore whatever was active when
    // the run began, which is what the application had on screen at that point.
    out += applyRun(token.value, rules, budgets, sgr.restore, stats, spent, onMatch)
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
  private onMatch?: MatchListener
  private buffer = ''
  /** Whether `buffer` holds any ESC — lets push skip the O(buffer) escape scans on escape-free floods. */
  private bufferHasEsc = false
  /**
   * The application's SGR state, kept for the lifetime of the stream: a colour
   * set in one chunk stays in force for the next, so split output restores the
   * same sequences as single-chunk output.
   */
  private sgr = new SgrState()

  constructor(rules: CompiledRule[], onMatch?: MatchListener) {
    this.rules = rules
    this.onMatch = onMatch
  }

  /** Swap the active rules without touching any buffered content. */
  setRules(rules: CompiledRule[]): void {
    this.rules = rules
  }

  /** Attach or drop the optional stats sink (see `highlightStats`). */
  setStats(stats: StatsSink | undefined): void {
    this.stats = stats
  }

  /** Attach or drop the match-event outlet (see `MatchListener`). */
  setOnMatch(onMatch: MatchListener | undefined): void {
    this.onMatch = onMatch
  }

  /** True while content is held back (a pending flush will release it). */
  hasPending(): boolean {
    return this.buffer.length > 0
  }

  /**
   * Join held bytes with `chunk`, return content safe to hand to xterm.
   *
   * Every `applyHighlights` call below passes the same `onMatch`, so a match
   * reports exactly once no matter which path (fast text path, incomplete-escape
   * carry, closed-escape split) happened to release the bytes — a rule whose
   * span straddles a chunk boundary still reports when it is finally painted,
   * which is the property `hl-split-smoke` guards for the output bytes.
   */
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
        return applyHighlights(raw, this.rules, this.stats, this.sgr, this.onMatch)
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
        return applyHighlights(head, this.rules, this.stats, this.sgr, this.onMatch) + tail
      }
      this.buffer = tail
      this.bufferHasEsc = true // the held tail starts at the dangling ESC
      return applyHighlights(head, this.rules, this.stats, this.sgr, this.onMatch)
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
        return applyHighlights(raw, this.rules, this.stats, this.sgr, this.onMatch)
      }
      // The buffer (or the chunk that just joined it) brought the ESC in.
      this.bufferHasEsc = true
      return ''
    }
    const head = this.buffer.slice(0, lastEnd)
    this.buffer = this.buffer.slice(lastEnd)
    this.bufferHasEsc = this.buffer.includes('\x1b')
    return applyHighlights(head, this.rules, this.stats, this.sgr, this.onMatch)
  }

  /** Flush any held content (session end) — highlighted as a final run. */
  flush(): string {
    const b = this.buffer
    this.buffer = ''
    this.bufferHasEsc = false
    return applyHighlights(b, this.rules, this.stats, this.sgr, this.onMatch)
  }
}

/** Exposed for self-tests only — not part of the public contract. */
export const __testHooks = { tokenize, hexToRgb, isIncompleteEscape, findIncompleteIndex, lastEscapeEnd }