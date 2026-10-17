/**
 * Clickable link rule self-test (link-rules.mjs).
 *
 * `src/shared/linkRules.ts` is the whole engine behind "regex hits terminal
 * output → the match becomes a clickable link": validation on load, template
 * expansion, the scheme gate and the span merge that keeps user rules and the
 * built-in URL heuristics from overlapping.
 *
 * The tables below pin behaviour that is easy to break silently:
 *
 *   - sanitize drops what cannot work (no id, an uncompilable regex, an empty
 *     template, a duplicate id) and keeps what merely defaults (`enabled`
 *     absent = on);
 *   - `formatLinkTemplate` expands `$0`–`$9` and `$$`, leaves a `$` before
 *     anything else alone, and consumes only ONE digit (`$10` = group 1 + "0");
 *   - a missing / non-participating group expands to nothing rather than the
 *     literal "undefined";
 *   - the scheme gate rejects `file:`, `javascript:`, `ms-settings:` and
 *     anything unparsable — a template is user input and must never hand an
 *     arbitrary handler to the OS;
 *   - `findRuleLinks` claims earlier rules first and never emits overlapping
 *     ranges, including a pattern that can match the empty string;
 *   - `mergeLinkSpans` keeps the user rule and drops the colliding built-in.
 *
 * Direct .ts import (no esbuild bundle): the module has no imports and no
 * runtime-only TS syntax, and Node >= 22.18 strips types itself.
 * Run: node tests/link-rules.mjs   (must exit 0)
 */
import {
  LINK_NOTE_MAX,
  LINK_PATTERN_MAX,
  LINK_RULES_MAX,
  LINK_TEMPLATE_MAX,
  LINK_TEXT_MAX,
  compileLinkRules,
  formatLinkTemplate,
  findRuleLinks,
  isSafeLinkTarget,
  mergeLinkSpans,
  sanitizeLinkRules,
  isSafeLinkTemplate
} from '../src/shared/linkRules.ts'

let failed = 0
const ok = (cond, msg) => {
  console.log(`  ${cond ? 'ok' : 'FAIL'}: ${msg}`)
  if (!cond) failed += 1
}

const raw = (over) => ({ id: 'r1', pattern: '\\b(\\d+)\\b', template: 'https://x/$1', ...over })

// ---- sanitize ---------------------------------------------------------------
console.log('[sanitize]')
{
  const out = sanitizeLinkRules([raw()])
  ok(out.length === 1, 'a well-formed rule is kept')
  ok(out[0].enabled === true, 'an absent enabled flag defaults to true')
  ok(out[0].note === undefined, 'an absent note stays undefined (not "")')
}

{
  const out = sanitizeLinkRules([raw({ enabled: false })])
  ok(out[0].enabled === false, 'enabled: false survives')
}

{
  const out = sanitizeLinkRules([raw({ note: '  build id  ' })])
  ok(out[0].note === 'build id', 'the note is trimmed')
}

{
  const long = 'n'.repeat(LINK_NOTE_MAX + 20)
  const out = sanitizeLinkRules([raw({ note: long })])
  ok(out[0].note.length === LINK_NOTE_MAX, `a long note is truncated to ${LINK_NOTE_MAX}`)
}

const dropped = [
  ['a non-array value', 'nope'],
  ['null', null],
  ['an array of scalars', ['x', 1, null]],
  ['a missing id', [raw({ id: undefined })]],
  ['an empty id', [raw({ id: '' })]],
  ['a numeric id', [raw({ id: 7 })]],
  ['a missing pattern', [raw({ pattern: undefined })]],
  ['an empty pattern', [raw({ pattern: '' })]],
  ['a whitespace-only pattern', [raw({ pattern: '   ' })]],
  ['an uncompilable regex', [raw({ pattern: '(unclosed' })]],
  ['a missing template', [raw({ template: undefined })]],
  ['an empty template', [raw({ template: '' })]],
  ['a whitespace-only template', [raw({ template: '   ' })]],
  ['an over-long pattern', [raw({ pattern: 'a'.repeat(LINK_PATTERN_MAX + 1) })]]
]
for (const [label, value] of dropped) {
  const out = sanitizeLinkRules(value)
  ok(out.length === 0, `${label} yields no rules (got ${JSON.stringify(out)})`)
}

{
  const warnings = []
  sanitizeLinkRules([raw(), raw()], (m) => warnings.push(m))
  // two identical entries share id 'r1': the second is a duplicate
  const out = sanitizeLinkRules([raw(), raw(), raw({ id: 'r2' })])
  ok(out.length === 2 && out[1].id === 'r2', 'a duplicate id is dropped, later distinct ids survive')
  ok(warnings.length >= 1, 'the warn callback receives a message for each dropped entry')
}

{
  const many = Array.from({ length: LINK_RULES_MAX + 5 }, (_, i) => raw({ id: `r${i}` }))
  const out = sanitizeLinkRules(many)
  ok(out.length === LINK_RULES_MAX, `no more than ${LINK_RULES_MAX} rules are kept (got ${out.length})`)
}

{
  // an unparsable regex would otherwise throw on every line the terminal draws
  const out = sanitizeLinkRules([raw({ pattern: 'a{2,1}' })])
  ok(out.length === 0, 'a regex with an invalid quantifier range is dropped')
}

// ---- formatLinkTemplate -----------------------------------------------------
console.log('[formatLinkTemplate]')
const expand = (template, source, pattern) =>
  formatLinkTemplate(template, new RegExp(pattern, 'g').exec(source))

const formatCases = [
  ['$0 is the whole match', 'https://x/$0', 'abc 123', '\\d+', 'https://x/123'],
  ['$1 is the first group', 'https://x/$1', 'abc 123', '(\\d+)', 'https://x/123'],
  ['$2 is the second group', 'https://x/$2/$1', 'k=v', '=(\\w+)', 'https://x//v'],
  ['$0 and $1 together', '$0|$1', 'ab12', '([a-z]+)(\\d+)', 'ab12|ab'],
  ['$9 is the ninth group', 'https://x/$9', '123456789', '(1)(2)(3)(4)(5)(6)(7)(8)(9)', 'https://x/9'],
  ['a template with no placeholders is literal', 'https://x/static', 'abc', 'abc', 'https://x/static'],
  ['$$ is a literal $', 'https://x/a$$b', 'abc', 'abc', 'https://x/a$b'],
  ['a $ before a letter stays literal', 'https://x/$a', 'abc', 'abc', 'https://x/$a'],
  ['a trailing $ stays literal', 'https://x/$', 'abc', 'abc', 'https://x/$'],
  ['$10 reads group 1 then a literal 0', 'https://x/$10', 'ab', '([a-z])b', 'https://x/a0'],
  [
    'a non-participating group expands to nothing',
    'https://x/$1$2',
    'ab',
    '(a)(b)?',
    'https://x/ab'
  ]
]
for (const [label, template, source, pattern, expected] of formatCases) {
  const got = expand(template, source, pattern)
  ok(got === expected, `${label}: ${JSON.stringify(got)}${got === expected ? '' : ` (want ${JSON.stringify(expected)})`}`)
}

{
  // the "undefined" leak that made a $2 on a one-group match render as text
  const got = expand('https://x/$2', 'abc', '(\\w+)')
  ok(!got.includes('undefined'), 'a group the pattern does not have never renders "undefined"')
}

// ---- isSafeLinkTarget -------------------------------------------------------
console.log('[isSafeLinkTarget]')
const safe = ['https://example.com', 'http://localhost:5000/x', 'HTTPS://EXAMPLE.COM', '  https://a.b  ']
for (const url of safe) ok(isSafeLinkTarget(url), `${JSON.stringify(url)} is allowed`)

const unsafe = [
  '',
  '   ',
  'file:///c:/windows',
  'javascript:alert(1)',
  'ms-settings:privacy',
  'vscode://file/x',
  'ftp://f.example.com',
  '//example.com',
  '/relative/path',
  'example.com',
  'mailto:user@example.com'
]
for (const url of unsafe) ok(!isSafeLinkTarget(url), `${JSON.stringify(url)} is refused`)

// ---- isSafeLinkTemplate -----------------------------------------------------
console.log('[isSafeLinkTemplate]')
const templateSafe = [
  'https://example.com',
  'http://localhost:5000/$1',
  '  https://a.b/$2  ',
  '$0',
  '$1',
  '$9/x'
]
for (const template of templateSafe) {
  ok(isSafeLinkTemplate(template), `template ${JSON.stringify(template)} is allowed`)
}

const templateUnsafe = [
  '',
  '   ',
  'file:///c:/windows',
  'javascript:alert(1)',
  'ms-settings:privacy',
  'ftp://f.example.com/$1',
  '/relative/$1',
  'example.com/$1',
  'www.example.com/$1'
]
for (const template of templateUnsafe) {
  ok(!isSafeLinkTemplate(template), `template ${JSON.stringify(template)} is refused`)
}

// ---- compileLinkRules -------------------------------------------------------
console.log('[compileLinkRules]')
{
  ok(compileLinkRules(undefined).length === 0, 'an absent rule list compiles to nothing')
  ok(compileLinkRules([]).length === 0, 'an empty rule list compiles to nothing')
  const compiled = compileLinkRules([
    { id: 'a', pattern: 'x', template: 'https://x/a' },
    { id: 'b', pattern: 'y', template: 'https://x/b', enabled: false },
    { id: 'c', pattern: 'z', template: 'https://x/c', enabled: true }
  ])
  ok(compiled.length === 2, 'disabled rules are not compiled')
  ok(compiled[0].regex.flags.includes('g'), 'the compiled regex is global')
}

// ---- findRuleLinks ----------------------------------------------------------
console.log('[findRuleLinks]')
const find = (text, rules) =>
  findRuleLinks(text, compileLinkRules(rules)).map((s) => [s.start, s.end, s.url])

const ruleSet = [{ id: 't', pattern: 'BUG-(\\d+)', template: 'https://tracker/bug/$1' }]

{
  ok(
    JSON.stringify(find('see BUG-42 please', ruleSet)) ===
      JSON.stringify([[4, 10, 'https://tracker/bug/42']]),
    'a match becomes a range carrying the expanded target'
  )
  ok(
    JSON.stringify(find('no match here', ruleSet)) === JSON.stringify([]),
    'a line without a match yields no ranges'
  )
  ok(
    JSON.stringify(find('BUG-1 BUG-2', ruleSet)) ===
      JSON.stringify([
        [0, 5, 'https://tracker/bug/1'],
        [6, 11, 'https://tracker/bug/2']
      ]),
    'two matches on one line keep their own offsets'
  )
}

{
  const unSafe = [{ id: 'f', pattern: 'FILE:(\\S+)', template: 'file://$1' }]
  ok(
    JSON.stringify(find('FILE:/c/windows', unSafe)) === JSON.stringify([]),
    'a file:// template produces no range at all (it never becomes clickable)'
  )
  const js = [{ id: 'j', pattern: 'X(\\d+)', template: 'javascript:alert($1)' }]
  ok(JSON.stringify(find('X1', js)) === JSON.stringify([]), 'a javascript: template is refused')
}

{
  // no template → the matched text itself may be the target, as long as it is
  // already a safe URL
  const bare = [{ id: 'b', pattern: 'https?://\\S+', template: '$0' }]
  ok(
    JSON.stringify(find('open https://a.io/x now', bare)) ===
      JSON.stringify([[5, 19, 'https://a.io/x']]),
    '$0 with an https match is clickable'
  )
}

{
  const first = { id: '1', pattern: 'BUG-(\\d+)', template: 'https://one/$1' }
  const second = { id: '2', pattern: 'BUG-\\d+', template: 'https://two/$0' }
  ok(
    JSON.stringify(find('BUG-7', [first, second])) === JSON.stringify([[0, 5, 'https://one/7']]),
    'the earlier rule claims a span the later one may not overlap'
  )
}

{
  // an empty-matching pattern must not loop forever
  const empty = [{ id: 'e', pattern: 'a*', template: 'https://x/$0' }]
  const out = find('baaa', empty)
  ok(out.length >= 1, 'a pattern that can match empty still yields the non-empty matches')
  ok(
    out.every(([start, end]) => end > start),
    'no zero-width range is emitted'
  )
}

{
  const tooLong = 'x'.repeat(LINK_TEXT_MAX + 1) + 'BUG-1'
  ok(
    JSON.stringify(find(tooLong, ruleSet)) === JSON.stringify([]),
    'a line past the length cap is not matched at all'
  )
}

// ---- mergeLinkSpans ---------------------------------------------------------
console.log('[mergeLinkSpans]')
{
  const user = [{ start: 0, end: 6, url: 'https://user/1' }]
  const builtin = [{ start: 0, end: 5, url: 'http://builtin/1' }]
  const merged = mergeLinkSpans(user, builtin)
  ok(merged.length === 1 && merged[0].url === 'https://user/1', 'a user rule wins an overlapping built-in')
}

{
  const user = [{ start: 0, end: 6, url: 'https://user/1' }]
  const builtin = [{ start: 10, end: 20, url: 'http://builtin/2' }]
  const merged = mergeLinkSpans(user, builtin)
  ok(
    merged.length === 2 && merged[0].start === 0 && merged[1].start === 10,
    'disjoint ranges from both sources are all kept, sorted by start'
  )
}

{
  const merged = mergeLinkSpans([], [{ start: 5, end: 9, url: 'http://b' }])
  ok(merged.length === 1, 'with no user rules the built-ins pass through unchanged')
  ok(mergeLinkSpans([], []).length === 0, 'two empty sources merge to nothing')
  ok(mergeLinkSpans([], []) !== mergeLinkSpans([], []), 'each call returns its own array')
}

{
  // built-ins arrive from findUrls already sorted and non-overlapping; the merge
  // must not disturb a long-scheme match that beat a shorter bare-host one
  const merged = mergeLinkSpans([], [
    { start: 0, end: 21, url: 'http://localhost:5000' },
    { start: 22, end: 41, url: 'https://example.com' }
  ])
  ok(merged.length === 2 && merged[0].end <= merged[1].start, 'merged ranges never overlap')
}

if (failed > 0) {
  console.error(`\n[link-rules] ${failed} check(s) FAILED`)
  process.exit(1)
}
console.log('\n[link-rules] ALL CHECKS PASSED')
