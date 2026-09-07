// Split-chunk regression test for HighlightStream.
// Builds the engine + TerminalView-free stream, feeds a kimi-like banner in
// deliberately nasty chunk splits, and requires byte-identical output vs the
// single-chunk reference.
import { compileRules, applyHighlights, HighlightStream } from '../src/renderer/src/terminal/highlightEngine.ts'

const rules = compileRules([
  { id: 'okstate', pattern: '\\b(SUCCESS|PASS|OK|DONE)\\b', enabled: true, priority: 5, color: { fg: '#3fb950' } },
  { id: 'badstate', pattern: '\\b(ERROR|FAILED)\\b', enabled: true, priority: 6, color: { fg: '#f85149' } },
  { id: 'numbers', pattern: '\\b\\d+(?:\\.\\d+)?(?:%)?\\b', enabled: true, priority: 25, color: { fg: '#f2cc60' } },
  { id: 'url', pattern: 'https?://[^\\s]+', enabled: true, priority: 30, color: { fg: '#58a6ff' } }
])

// kimi-like: truecolor SGR, OSC title, box drawing, per-line repaints
const banner =
  '\x1b]0;kimi — session\x07' +
  '\x1b[38;2;79;168;255m╭───────╮\x1b[0m\r\n' +
  '\x1b[38;2;136;136;136mWelcome to Kimi Code!\x1b[0m \x1b[38;2;79;168;255m│\x1b[0m send /help\r\n' +
  '\x1b[38;2;224;224;224mModel: MiniMax-M3 0.41.038 ERROR 99% https://example.com/x\x1b[0m\r\n'

const reference = applyHighlights(banner, rules)

// every possible single split point + a few double splits
let failed = 0
const splitAt = (s, i) => [s.slice(0, i), s.slice(i)]

for (let i = 1; i < banner.length - 1; i++) {
  const [a, b] = splitAt(banner, i)
  const stream = new HighlightStream(rules)
  const out = stream.push(a) + stream.push(b) + stream.flush()
  if (out !== reference) {
    failed++
    if (failed <= 3) {
      console.log(`MISMATCH at split ${i}:`)
      console.log('  got:      ' + JSON.stringify(out.slice(0, 120)))
      console.log('  expected: ' + JSON.stringify(reference.slice(0, 120)))
    }
  }
}

// double splits at 1/3 and 2/3, plus a pathological 1-byte-per-push feed
{
  const i = Math.floor(banner.length / 3)
  const j = Math.floor((banner.length * 2) / 3)
  const stream = new HighlightStream(rules)
  const out = stream.push(banner.slice(0, i)) + stream.push(banner.slice(i, j)) + stream.push(banner.slice(j)) + stream.flush()
  if (out !== reference) failed++
}

{
  const stream = new HighlightStream(rules)
  let out = ''
  for (const ch of banner) out += stream.push(ch)
  out += stream.flush()
  if (out !== reference) failed++
}

if (failed === 0) {
  console.log('SPLIT-SMOKE PASS: all split points byte-identical to single-chunk reference')
  process.exit(0)
} else {
  console.log(`SPLIT-SMOKE FAIL: ${failed} mismatches`)
  process.exit(1)
}
