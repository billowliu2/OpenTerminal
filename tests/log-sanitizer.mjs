/**
 * Session-log sanitizer self-test (log-sanitizer.mjs).
 *
 * src/main/logSanitizer.ts turns raw PTY output into a readable text log
 * (commands.ts drives it in logWrite/logStop, one instance per logged
 * session). It is a hand-written state machine over bytes, which is exactly
 * the shape that fails at chunk boundaries — the PTY hands out arbitrary
 * splits, and an escape sequence is regularly cut in half between two chunks.
 * What is pinned here:
 *
 *   - every escape family the terminal emits is consumed, not printed: CSI
 *     (SGR), OSC terminated by BEL *and* by ST, single-character escapes,
 *     the two-byte charset designators, and an OSC interrupted by a new ESC
 *   - state survives a chunk boundary at every position of the nasty sample
 *     (byte-identical to the single-chunk result), including 1 byte per push
 *   - `\r` collapses an overwritten line (progress bars) while `\r\n` stays a
 *     line ending; a trailing `\r` at flush is an ending too
 *   - alt-screen output is dropped and reported by exactly one marker per
 *     suppressed span, including when the log stops mid-TUI
 *   - a runaway CSI resyncs as text past the 1024-byte cap instead of
 *     swallowing the rest of the session
 *   - DEL / other C0 controls are dropped, tab is preserved
 *
 * Build: node tests/build-bundles.cjs
 * Run:   node tests/log-sanitizer.mjs   (must exit 0)
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { LogSanitizer } = require('./.log-sanitizer.cjs')

let failed = 0
let passed = 0
const ok = (cond, msg) => {
  console.log(`  ${cond ? 'ok' : 'FAIL'}: ${msg}`)
  if (!cond) failed += 1
  else passed += 1
}

/** Fresh sanitizer + "push these chunks, then flush" through one call. */
const run = (...chunks) => {
  const s = new LogSanitizer()
  let out = ''
  for (const c of chunks) out += s.push(c)
  return { out, out2: out + s.flush() }
}

/** Push, then flush, and require the result. */
const feed = (...chunks) => run(...chunks).out2
/** Push only — used when the assertion is about what has NOT been emitted yet. */
const pushed = (...chunks) => run(...chunks).out

const MARKER_RE = /\n──── \[[^\]]+\] ────\n/g
const markerCount = (s) => (s.match(MARKER_RE) ?? []).length
const marker = (() => {
  const { out } = run('\x1b[?1049h', 'x', '\x1b[?1049l')
  return out
})()

// ---- 1. plain text and line endings ----------------------------------------
console.log('plain text')
ok(feed('hello\nworld') === 'hello\nworld', 'an unterminated tail is flushed at the end')
ok(feed('hello\n') === 'hello\n', 'a terminated line comes out as-is')
ok(pushed('hello\nworld') === 'hello\n', 'nothing is emitted for the pending line until flush')
ok(feed('\n') === '\n', 'an empty line is preserved')
ok(feed('a\nb\nc') === 'a\nb\nc', 'multiple lines')
ok(feed('') === '', 'no input, no output')
ok(markerCount(marker) === 1, `the alt-screen marker has the expected shape (${JSON.stringify(marker)})`)

console.log('\\r vs \\r\\n')
ok(feed('progress 10%\rprogress 100%\n') === 'progress 100%\n', '\\r collapses an overwritten progress line')
ok(feed('a\rb\rc\n') === 'c\n', 'chained \\r overwrites keep only the last write')
ok(feed('line\r\n') === 'line\n', '\\r\\n is a line ending, not an overwrite')
ok(feed('one\r\ntwo\r\n') === 'one\ntwo\n', 'several \\r\\n lines')
ok(feed('partial\r') === 'partial\n', 'a trailing \\r at flush is treated as a line ending')
ok(feed('a\r\rb\n') === 'b\n', 'a doubled \\r still collapses')
ok(
  feed('prog 1\r', 'prog 2\n') === 'prog 2\n',
  'a \\r at the end of one chunk still overwrites with the next chunk'
)
ok(feed('prog 1\r', '\n') === 'prog 1\n', 'a \\r at the end of a chunk followed by \\n is an ending')

// ---- 2. escape sequences are consumed --------------------------------------
console.log('CSI / SGR')
ok(feed('\x1b[31mred\x1b[0m\n') === 'red\n', 'SGR color codes vanish')
ok(feed('\x1b[38;2;1;2;3mtruecolor\x1b[0m\n') === 'truecolor\n', 'truecolor SGR vanishes')
ok(feed('\x1b[1;2Hpositioned\n') === 'positioned\n', 'cursor positioning vanishes')
ok(feed('\x1b[2J\x1b[Hcleared\n') === 'cleared\n', 'screen clear / home vanish')
ok(feed('\x1b[?25lcursor\n') === 'cursor\n', 'a DEC private mode with a trailing l vanishes')

console.log('OSC (title / hyperlink), both terminators')
ok(feed('\x1b]0;title\x07after\n') === 'after\n', 'OSC terminated by BEL is consumed')
ok(feed('\x1b]0;title\x1b\\after\n') === 'after\n', 'OSC terminated by ST (ESC \\) is consumed')
ok(feed('\x1b]8;;https://example.com\x07link\x1b]8;;\x07\n') === 'link\n', 'OSC 8 hyperlink open+close')
ok(
  feed('\x1b]0;t\x1b[31mx\n') === 'x\n',
  'an OSC interrupted by a new ESC [ resumes as CSI instead of eating the sequence'
)
ok(feed('\x1b]0;t\x1b]0;u\x07ok\n') === 'ok\n', 'an OSC interrupted by a new ESC ] continues as OSC')
ok(feed('\x1b]0;t\x1bZrest\n') === 'rest\n', 'ESC + an unrelated byte ends the OSC (byte consumed)')

console.log('single-character escapes and charset designators')
ok(feed('\x1b7saved\x1b8restored\n') === 'savedrestored\n', 'DECSC/DECRC (ESC 7 / ESC 8) vanish')
ok(feed('\x1b=app\x1b>norm\n') === 'appnorm\n', 'ESC = / ESC > vanish')
ok(feed('\x1b(Bplain\n') === 'plain\n', 'the charset designator ESC ( B is consumed whole')
ok(feed('\x1b)0line\n') === 'line\n', 'ESC ) 0 is consumed whole')
ok(feed('\x1b#8screen\n') === 'screen\n', 'the DECALN designator ESC # 8 is consumed whole')
ok(feed('\x1b%Gutf8\n') === 'utf8\n', 'the encoding designator ESC % G is consumed whole')

console.log('control characters')
ok(feed('a\tb\n') === 'a\tb\n', 'tab is preserved')
ok(feed('a\x07b\x00c\x1fd\n') === 'abcd\n', 'BEL / NUL / other C0 controls are dropped')
// DEL (0x7F) is not a C0 control: it passes the `c >= ' '` test and is kept.
// The comment in logSanitizer.ts used to claim otherwise; this pins the real
// behaviour so the two cannot drift again.
ok(feed('a\x7fb\n') === 'a\x7fb\n', 'DEL is kept as an ordinary character (it is not a C0 control)')

// ---- 3. chunk boundaries ----------------------------------------------------
console.log('state survives chunk boundaries')
ok(feed('\x1b', '[31mred\n') === 'red\n', 'ESC at the end of a chunk')
ok(feed('\x1b[3', '1mred\n') === 'red\n', 'CSI split mid-parameter')
ok(feed('\x1b]', '0;title\x07ok\n') === 'ok\n', 'OSC introducer split')
ok(feed('\x1b]0;title\x1b', '\\after\n') === 'after\n', 'ESC of the ST terminator split from its backslash')
ok(feed('\x1b(', 'Bplain\n') === 'plain\n', 'charset designator split')
ok(feed('\x1b[?1049h', 'a', '\x1b[?1049l', 'b\n') === marker + 'b\n', 'alt-screen toggles split across chunks')

// A nasty sample exercising every family, cut at every single position: the
// concatenated result must be byte-identical to the single-chunk result.
const nasty =
  '\x1b]0;kimi — session\x07' +
  '\x1b[38;2;79;168;255m╭──╮\x1b[0m\r\n' +
  'Welcome \x1b[1mbold\x1b[0m\r\n' +
  '\x1b7' +
  '\x1b[?25lhidden\x1b[?25h' +
  '\x1b(Bascii\x1b)0gfx' +
  '\x1b#8' +
  '\x1b%Gutf8' +
  '\x1b[mreset\r' +
  'overwritten\x1b[K\r\n' +
  '\x1b[?1049hTUI frame A\r\nTUI frame B\x1b[?1049l' +
  '\x1b]8;;https://x.example\x1b\\link\x1b]8;;\x1b\\' +
  'done \u2713\r\n'
const reference = feed(nasty)

{
  let mismatches = 0
  for (let i = 1; i < nasty.length - 1; i++) {
    const got = feed(nasty.slice(0, i), nasty.slice(i))
    if (got !== reference) {
      mismatches++
      if (mismatches <= 3) {
        console.log(`    split ${i}: got ${JSON.stringify(got.slice(0, 90))}`)
        console.log(`              want ${JSON.stringify(reference.slice(0, 90))}`)
      }
    }
  }
  ok(mismatches === 0, `every single split point is byte-identical to the whole-chunk result (${mismatches} mismatches)`)
}

{
  let got = ''
  const s = new LogSanitizer()
  for (const ch of nasty) got += s.push(ch)
  got += s.flush()
  ok(got === reference, 'a 1-byte-per-push feed is byte-identical')
}

{
  const third = Math.floor(nasty.length / 3)
  ok(
    feed(nasty.slice(0, third), nasty.slice(third, third * 2), nasty.slice(third * 2)) === reference,
    'a three-way split is byte-identical'
  )
}

{
  // A random 4-way split (fixed seed via a simple LCG so a failure reproduces).
  let seed = 12345
  const rand = (n) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed % n
  }
  let allEqual = true
  for (let trial = 0; trial < 50; trial++) {
    const cuts = [1 + rand(nasty.length - 1), 1 + rand(nasty.length - 1), 1 + rand(nasty.length - 1)].sort((a, b) => a - b)
    const chunks = [nasty.slice(0, cuts[0]), nasty.slice(cuts[0], cuts[1]), nasty.slice(cuts[1], cuts[2]), nasty.slice(cuts[2])]
    if (feed(...chunks) !== reference) allEqual = false
  }
  ok(allEqual, '50 pseudo-random 4-way splits are all byte-identical')
}

// ---- 4. alt screen ---------------------------------------------------------
console.log('alt screen (TUI frames) is dropped, one marker per span')
ok(feed('\x1b[?1049hframe\r\nframe\x1b[?1049l') === marker, 'a TUI span yields exactly the marker')
ok(markerCount(feed('\x1b[?1049hframe\x1b[?1049l')) === 1, 'one span, one marker')
ok(
  markerCount(feed('\x1b[?1049ha\x1b[?1049lb\x1b[?1049hc\x1b[?1049l')) === 2,
  'two spans, two markers'
)
ok(feed('\x1b[?1049h\x1b[?1049l') === '', 'an alt-screen toggle with no output emits nothing')
ok(pushed('\x1b[?1049hframe') === '', 'TUI output is suppressed while the alt screen is active')
ok(feed('before\n\x1b[?1049hframe\x1b[?1049lafter\n') === 'before\n' + marker + 'after\n', 'text around a TUI span survives')

console.log('alt-screen toggles recognised: 1049 / 1047 / 47')
for (const n of ['1049', '1047', '47']) {
  ok(
    feed(`\x1b[?${n}htui\x1b[?${n}l`) === marker,
    `${n}h/${n}l is an alt-screen toggle`
  )
}
ok(feed('\x1b[?1048hnotalt\n') === 'notalt\n', '1048 (save cursor) is NOT an alt-screen toggle')
ok(feed('\x1b[?25hnotalt\n') === 'notalt\n', 'a private mode with no toggle is not an alt-screen toggle')
ok(
  feed('\x1b[?1049hbody\x1b[?1049l\n') === marker + '\n',
  'once the alt screen closes, later output is normal again'
)

console.log('stopping the log mid-TUI still reports the suppressed span')
ok(feed('normal\n\x1b[?1049hframe') === 'normal\n' + marker, 'flush inside the alt screen emits the marker')
ok(feed('normal\n\x1b[?1049h') === 'normal\n', 'flush inside an empty alt screen emits nothing')
{
  // Two spans, the second still open at flush: one marker when it closed, one
  // for the span the flush interrupted.
  const out = feed('\x1b[?1049ha\x1b[?1049l\x1b[?1049hb')
  ok(markerCount(out) === 2, `an open span at flush gets its own marker (${markerCount(out)})`)
}

console.log('a TUI span does not consume the pending normal-buffer line')
{
  // Documented boundary: text committed to the normal buffer before the TUI
  // opened is still the pending line and is emitted after the span closes.
  const out = feed('abc\x1b[?1049hdef\x1b[?1049l\n')
  ok(out === marker + 'abc\n', `pending normal-buffer line survives a TUI span (${JSON.stringify(out)})`)
}

// ---- 5. runaway sequence cap ------------------------------------------------
console.log('a runaway CSI resyncs instead of swallowing the session')
{
  // The cap counts the bytes held in `seq` (1024). The byte that trips the cap
  // is consumed by the resync itself, so the first 1025 parameter bytes are
  // swallowed and everything after them spills as plain text.
  const params = '1'.repeat(1100)
  const out = feed('\x1b[' + params, 'text\n')
  ok(out.endsWith('text\n'), 'output after the runaway sequence is still logged')
  ok(out === params.slice(1025) + 'text\n', `exactly the bytes past the 1024 cap become text (${out.length} bytes)`)
  ok(!out.includes('\x1b'), 'the introducer itself is not leaked into the log')
}
{
  // A runaway OSC has no cap (it is terminated by BEL/ST only), so it must stay
  // swallowed rather than leak the sequence body into the log.
  const out = feed('\x1b]0;' + 'x'.repeat(5000) + '\x07after\n')
  ok(out === 'after\n', 'a long but terminated OSC is fully swallowed')
}

// ---- 6. flush is idempotent -------------------------------------------------
console.log('flush')
{
  const s = new LogSanitizer()
  s.push('pending')
  ok(s.flush() === 'pending', 'the first flush emits the pending line')
  ok(s.flush() === '', 'a second flush emits nothing')
  ok(s.push('more').length === 0, 'the sanitizer keeps working after a flush')
  ok(s.flush() === 'more', 'and flushes the new pending line')
}
{
  const s = new LogSanitizer()
  s.push('\x1b[?1049hframe')
  const first = s.flush()
  ok(markerCount(first) === 1, 'flush reports the open TUI span once')
  ok(s.flush() === '', 'the marker is not repeated by a second flush')
}

if (failed > 0) {
  console.error(`\n[log-sanitizer] ${failed} check(s) FAILED`)
  process.exit(1)
}
console.log(`\n[log-sanitizer] ALL CHECKS PASSED (${passed} assertions)`)
