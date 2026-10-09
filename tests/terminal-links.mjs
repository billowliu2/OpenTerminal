/**
 * Clickable-URL self-test (terminal-links.mjs).
 *
 * `src/renderer/src/terminal/urlLinks.ts` feeds xterm's link provider: it scans
 * one *logical* line (the provider rebuilds it across wrapped rows first) and
 * returns half-open `[start, end)` ranges plus a scheme-carrying target. The
 * ranges are what the terminal underlines and what a click opens, so the table
 * pins the real contract rather than an idealised one:
 *
 *   - `http(s)://` and `ftp://` are handed over as written (the match is
 *     case-insensitive, the target keeps the original case); `www.…`,
 *     `localhost:port`, `127.0.0.1:port` and `0.0.0.0:port` get an `http://`
 *     target added;
 *   - a bare host WITHOUT a port is not a link, and a bare domain without `www.`
 *     never is — the two shapes that would otherwise make every `foo.com` in
 *     build output clickable;
 *   - trailing sentence punctuation (`. , ; : ! ? ) ] } > ' "` plus the CJK
 *     forms) is stripped from the URL *and* from `end`, so the closing bracket
 *     of a sentence is not underlined. Brackets, quotes and whitespace cannot
 *     appear inside the body at all;
 *   - ranges never overlap: `http://localhost:5000` also matches the bare-host
 *     pattern, and the longer, scheme-carrying match wins;
 *   - the body is greedy up to the next whitespace, so `http://a/http://b` is
 *     one link — a documented limitation, not an accident to be "fixed" here.
 *
 * Direct .ts import (no esbuild bundle needed): the module has no imports and no
 * runtime-only TS syntax, and Node >= 22.18 strips types itself.
 * Run: node tests/terminal-links.mjs   (must exit 0)
 */
import { findUrls } from '../src/renderer/src/terminal/urlLinks.ts'

let failed = 0
const ok = (cond, msg) => {
  console.log(`  ${cond ? 'ok' : 'FAIL'}: ${msg}`)
  if (!cond) failed += 1
}

/** [start, end, url] triples — compact enough to keep the tables readable. */
const triples = (text) => findUrls(text).map((l) => [l.start, l.end, l.url])

const table = (label, cases) => {
  console.log(label)
  for (const [text, expected] of cases) {
    const got = triples(text)
    ok(
      JSON.stringify(got) === JSON.stringify(expected),
      `${JSON.stringify(text)} -> ${JSON.stringify(got)}${JSON.stringify(got) === JSON.stringify(expected) ? '' : ` (want ${JSON.stringify(expected)})`}`
    )
  }
}

table('fully qualified http/https URLs are handed over as written', [
  ['https://example.com', [[0, 19, 'https://example.com']]],
  ['http://example.com/a/b?c=1#frag', [[0, 31, 'http://example.com/a/b?c=1#frag']]],
  ['see https://example.com/a.', [[4, 25, 'https://example.com/a']]],
  ['https://user:pass@host.com:8443/x', [[0, 33, 'https://user:pass@host.com:8443/x']]],
  ['\t\thttps://example.com/x', [[2, 23, 'https://example.com/x']]]
])

table('matching is case-insensitive, the target keeps the original case', [
  ['HTTP://EXAMPLE.COM', [[0, 18, 'HTTP://EXAMPLE.COM']]],
  ['Visit HTTPS://Example.COM/Path', [[6, 30, 'HTTPS://Example.COM/Path']]]
])

table('trailing sentence punctuation is not part of the link', [
  ['go to https://example.com.', [[6, 25, 'https://example.com']]],
  ['https://example.com, then', [[0, 19, 'https://example.com']]],
  ['https://example.com/a; ls', [[0, 21, 'https://example.com/a']]],
  ['https://example.com/a,;:!?', [[0, 21, 'https://example.com/a']]],
  ['(https://example.com/a)', [[1, 22, 'https://example.com/a']]],
  ['<https://example.com/a>', [[1, 22, 'https://example.com/a']]],
  ['"https://example.com/a"', [[1, 22, 'https://example.com/a']]],
  ["'https://example.com/a'", [[1, 22, 'https://example.com/a']]],
  ['[https://example.com/a]', [[1, 22, 'https://example.com/a']]],
  ['https://example.com/a).', [[0, 21, 'https://example.com/a']]]
])

table('CJK punctuation ends the link too', [
  ['中文 https://example.com/路径。然后', [[3, 25, 'https://example.com/路径']]],
  ['见 https://example.com/路径，还有', [[2, 24, 'https://example.com/路径']]],
  ['https://example.com/a、b', [[0, 21, 'https://example.com/a']]]
])

table('several URLs on one line keep their own offsets', [
  [
    'go to http://a.com and https://b.org/x?y=1!',
    [
      [6, 18, 'http://a.com'],
      [23, 42, 'https://b.org/x?y=1']
    ]
  ],
  [
    'x https://a.com https://a.com y',
    [
      [2, 15, 'https://a.com'],
      [16, 29, 'https://a.com']
    ]
  ]
])

table('overlapping matches collapse to the longest one', [
  ['http://localhost:5000', [[0, 21, 'http://localhost:5000']]],
  ['http://localhost:5000/x', [[0, 23, 'http://localhost:5000/x']]],
  ['localhost:3000 http://localhost:3000', [
    [0, 14, 'http://localhost:3000'],
    [15, 36, 'http://localhost:3000']
  ]],
  ['http://127.0.0.1:8080/x', [[0, 23, 'http://127.0.0.1:8080/x']]]
])

table('ftp is recognised as a scheme of its own', [
  ['ftp://files.example.com/pub', [[0, 27, 'ftp://files.example.com/pub']]],
  ['ftp://files.example.com/pub.', [[0, 27, 'ftp://files.example.com/pub']]]
])

table('scheme-less dev-server forms get an http:// target', [
  ['localhost:5000', [[0, 14, 'http://localhost:5000']]],
  ['localhost:5000/x', [[0, 16, 'http://localhost:5000/x']]],
  ['  Listening on http://0.0.0.0:3000', [[15, 34, 'http://0.0.0.0:3000']]],
  ['127.0.0.1:8080/x', [[0, 16, 'http://127.0.0.1:8080/x']]],
  ['www.example.com/path.', [[0, 20, 'http://www.example.com/path']]],
  ['WWW.EXAMPLE.COM', [[0, 15, 'http://WWW.EXAMPLE.COM']]],
  ['see www.example.com:8080', [[4, 24, 'http://www.example.com:8080']]]
])

table('shapes that must NOT become links', [
  ['no links here', []],
  ['', []],
  ['a.com', []],
  ['localhost', []],
  ['0.0.0.0', []],
  ['127.0.0.1', []],
  ['localhost:', []],
  ['xhttps://a.com', []],
  ['https://', []],
  ['mailto:user@example.com', []],
  ['file:///c:/x', []],
  ['ssh://git@host/repo', []],
  ['C:\\Users\\me', []],
  ['www.', []],
  ['www.example', []]
])

table('documented greedy behaviour: the body runs to the next whitespace', [
  ['http://a.com/http://b.com', [[0, 25, 'http://a.com/http://b.com']]],
  ['https://a.com/x\tand', [[0, 15, 'https://a.com/x']]],
  ['https://a.com/x and', [[0, 15, 'https://a.com/x']]]
])

console.log('the optional path group of a bare host needs a body character')
ok(
  JSON.stringify(triples('localhost:5000/')) === JSON.stringify([[0, 14, 'http://localhost:5000']]),
  'a trailing slash with nothing behind it is left out of the range'
)

console.log('every range is consistent with its own text')
const corpus = [
  'go to http://a.com and https://b.org/x?y=1!',
  '(https://a.com/a)',
  'http://a.com/http://b.com',
  'plain output, no links',
  'http://localhost:5000/x and www.example.com/y, then https://c.jp/z。',
  'ftp://f.io/a https://g.io/b',
  'https://example.com/path).',
  'localhost:3000/',
  'https://'
]
for (const text of corpus) {
  const found = findUrls(text)
  const ranges = found.map((l) => `${l.start}-${l.end}`)
  ok(
    found.every((l, i) => i === 0 || found[i - 1].end <= l.start),
    `${JSON.stringify(text)}: ranges do not overlap (${ranges.join(' ')})`
  )
  ok(
    found.every((l) => l.start >= 0 && l.end <= text.length && l.end > l.start),
    `${JSON.stringify(text)}: every range is inside the line and non-empty`
  )
  ok(
    found.every((l) => l.url.length === l.end - l.start || l.url.endsWith(text.slice(l.start, l.end))),
    `${JSON.stringify(text)}: the target matches the range it covers`
  )
  ok(
    found.every((l) => /^[a-z][a-z0-9+.-]*:\/\//i.test(l.url)),
    `${JSON.stringify(text)}: every target carries a scheme`
  )
}

console.log('the target of a bare host is the matched text behind http://')
ok(findUrls('localhost:5000')[0].url === 'http://localhost:5000', 'the matched text is kept verbatim behind the scheme')
ok(
  findUrls('go to https://example.com.')[0].url === 'https://example.com',
  'a scheme URL is not prefixed a second time'
)

if (failed > 0) {
  console.error(`\n[terminal-links] ${failed} check(s) FAILED`)
  process.exit(1)
}
console.log('\n[terminal-links] ALL CHECKS PASSED')
