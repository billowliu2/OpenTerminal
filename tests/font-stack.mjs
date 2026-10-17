/**
 * Font-family quoting self-test (font-stack.mjs).
 *
 * The font enumerator hands back BARE family names (`disableQuoting: true`), and
 * the picked name is stored verbatim in `settings.terminal.fontFamily` — one name
 * or a hand-written stack. Passing that straight to xterm's `fontFamily` or to the
 * settings preview's inline style only works because parsers are lenient: a name
 * with `(` `)` `+`, one starting with a digit, or one that collides with a CSS
 * keyword is not a valid CSS family. `quoteFontStack` fixes that at the consumer
 * sites, so the contract pinned here is:
 *
 *   - plain identifiers and the family keywords stay bare (quoting the keywords
 *     would turn `monospace` into a font literally named "monospace");
 *   - anything else is double-quoted, inner double quotes escaped;
 *   - splitting is on TOP-LEVEL commas only — a comma inside `'Name, with comma'`
 *     or `"Name"` is part of that family, not a separator;
 *   - already-quoted segments survive untouched, which makes the function
 *     idempotent: second pass over already-processed output is a no-op;
 *   - empty/blank input is the empty string (not `"\"\""`), so a cleared setting
 *     does not become a font family named "".
 *
 * Direct .ts import (no esbuild bundle needed): the module has no imports and no
 * runtime-only TS syntax, and Node >= 22.18 strips types itself.
 * Run: node tests/font-stack.mjs   (must exit 0)
 */
import { quoteFontStack } from '../src/renderer/src/terminal/fontStack.ts'

let failed = 0
const ok = (cond, msg) => {
  console.log(`  ${cond ? 'ok' : 'FAIL'}: ${msg}`)
  if (!cond) failed += 1
}

/** Table-driven: [input, expected]. */
const table = (label, cases) => {
  console.log(label)
  for (const [input, expected] of cases) {
    const got = quoteFontStack(input)
    ok(
      got === expected,
      `${JSON.stringify(input)} -> ${JSON.stringify(got)}${got === expected ? '' : ` (want ${JSON.stringify(expected)})`}`
    )
  }
}

table('plain identifiers and keywords are left alone', [
  ['Consolas', 'Consolas'],
  ['JetBrainsMono', 'JetBrainsMono'],
  ['DejaVu_Sans', 'DejaVu_Sans'],
  ['-apple-system', '-apple-system'],
  ['monospace', 'monospace'],
  ['serif', 'serif'],
  ['sans-serif', 'sans-serif'],
  ['cursive', 'cursive'],
  ['fantasy', 'fantasy'],
  ['system-ui', 'system-ui'],
  ['ui-monospace', 'ui-monospace'],
  ['default', 'default'],
  ['inherit', 'inherit'],
  ['initial', 'initial'],
  ['unset', 'unset'],
  ['Monospace', 'Monospace'],
  // a keyword mixed into a stack stays bare while the neighbours are judged apart
  ['Consolas,monospace', 'Consolas, monospace']
])

table('names CSS cannot parse bare get double quotes', [
  ['Cascadia Code (Preview)', '"Cascadia Code (Preview)"'],
  ['Fira Code + Ligatures', '"Fira Code + Ligatures"'],
  ['4uto', '"4uto"'],
  ['.SF NS Mono', '".SF NS Mono"'],
  ['微軟雅黑', '"微軟雅黑"'],
  ['微软雅黑', '"微软雅黑"'],
  ['ＭＳ ゴシック', '"ＭＳ ゴシック"'],
  ['My Font!', '"My Font!"'],
  ['IntelliJ IDEA-like', '"IntelliJ IDEA-like"'],
  ['name{with}braces', '"name{with}braces"']
])

table('existing quoting is preserved', [
  ["'JetBrains Mono'", "'JetBrains Mono'"],
  ['"JetBrains Mono"', '"JetBrains Mono"'],
  ["Consolas, 'Fira Code', monospace", 'Consolas, \'Fira Code\', monospace'],
  ['"Noto Sans CJK SC", sans-serif', '"Noto Sans CJK SC", sans-serif']
])

table('only top-level commas separate families', [
  ["'Name, with comma'", "'Name, with comma'"],
  ['"Name, with comma", monospace', '"Name, with comma", monospace'],
  ['"A, B"', '"A, B"'],
  ["'A, B', 'C, D'", "'A, B', 'C, D'"],
  // unquoted commas are separators, so this is two families, not one
  ['Name, with comma', 'Name, "with comma"']
])

table('segments are trimmed and empty ones dropped', [
  ['  Consolas  ,  monospace  ', 'Consolas, monospace'],
  ['Consolas,,monospace', 'Consolas, monospace'],
  [',Consolas,', 'Consolas'],
  ['Consolas , , monospace', 'Consolas, monospace'],
  ['  Cascadia Code (Preview)  ', '"Cascadia Code (Preview)"'],
  ['', ''],
  ['   ', ''],
  [',', ''],
  [' , , ', '']
])

table('inner double quotes are escaped, not nested', [
  ['Say "Hi"', '"Say \\"Hi\\""'],
  ['"Already" trailing', '"\\"Already\\" trailing"']
])

// Backslashes must be escaped too: escaping only `"` turned a name with a
// trailing backslash into `"a\"`, whose closing quote is itself escaped — the
// CSS string never terminates and the font silently falls back to the browser
// default. Every produced segment must therefore end with an EVEN run of
// backslashes before its closing quote.
table('backslashes are escaped so the CSS string stays terminated', [
  ['a\\', '"a\\\\"'],
  ['\\', '"\\\\"'],
  ['Font Name\\', '"Font Name\\\\"'],
  ['x\\"; color:red', '"x\\\\\\"; color:red"']
])

console.log('quoting is idempotent')
const stacks = [
  'Consolas',
  'Cascadia Code (Preview)',
  'Consolas, Cascadia Code (Preview), monospace',
  "Consolas, 'Fira Code', monospace",
  '"Name, with comma", monospace',
  '微软雅黑',
  ''
]
for (const stack of stacks) {
  const once = quoteFontStack(stack)
  ok(
    quoteFontStack(once) === once,
    `${JSON.stringify(stack)} survives a second pass (${JSON.stringify(once)})`
  )
}

console.log('the stored setting is the caller\'s problem (input is never mutated)')
const original = 'Cascadia Code (Preview)'
quoteFontStack(original)
ok(original === 'Cascadia Code (Preview)', 'the input string is untouched')

if (failed > 0) {
  console.error(`\n[font-stack] ${failed} check(s) FAILED`)
}
console.log('\n[font-stack] ALL CHECKS PASSED')
process.exit(failed ? 1 : 0)
