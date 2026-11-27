/**
 * Fail-closed guard: no raw color literals in renderer source outside the
 * whitelist. Scans .css/.tsx/.ts under src/renderer/src. Strips comments,
 * var() fallback bodies (those go through the controlled FALLBACK_OK list)
 * and color-mix() bodies first; lines containing '${' are skipped wholesale
 * (template-literal color BUILDERS like MonitorPanel's withAlpha construct
 * rgba() from variables — they contain no literal to police).
 * Run: node tests/css-theme-vars.mjs  (must exit 0)
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve('src/renderer/src')
/** exact relative path -> Set of allowed lowercase literals; null = whole file exempt */
const WHITELIST = {
  // The layer that DEFINES the anchors and derives per-theme values.
  'theme/semantic.ts': null,
  // Pre-existing --chrome-* derivation anchors (mix targets / overlay bases).
  // #181818 = global.css --chrome-bg, the pre-JS chromeBg default.
  'theme/chrome.ts': new Set([
    '#000000', '#ffffff', '#181818',
    'rgba(0, 0, 0, 0.045)', 'rgba(0, 0, 0, 0.09)', 'rgba(0, 0, 0, 0.18)', 'rgba(0, 0, 0, 0.32)',
    'rgba(255, 255, 255, 0.04)', 'rgba(255, 255, 255, 0.07)', 'rgba(255, 255, 255, 0.1)', 'rgba(255, 255, 255, 0.2)'
  ]),
  // Theme data: editor seeds itself from DEFAULT_DARK; preset swatches are rules.
  'theme/editor/ThemeEditor.tsx': null,
  'settings/HighlightTab.tsx': null,
  'terminal/highlightEngine.ts': null,
  // xterm search-match ITheme data + transparent-background markers.
  'terminal/TerminalView.tsx': new Set(['#3b8eea', '#2d2d2d', '#c77800', '#00000000']),
  // antd token fallbacks (mix() returning null on non-hex themes).
  'main.tsx': new Set(['#f5f5f5', '#1f1f1f', '#252525']),
  // :root static fallback block for --ot-*/--chrome-* (pre-JS = dark defaults).
  'global.css': new Set([
    '#181818', '#cccccc', '#2d2d2d', '#3b8eea', '#2a2a2a', '#101418', '#98a2ab', '#d0d0d0',
    '#8a8a8a', '#3fb950', '#f85149', '#d29922', '#58a6ff', '#ff6b6b', '#ffffff',
    'rgba(255, 255, 255, 0.04)', 'rgba(255, 255, 255, 0.07)', 'rgba(255, 255, 255, 0.1)',
    'rgba(255, 255, 255, 0.2)', 'rgba(255, 255, 255, 0.08)', 'rgba(255, 255, 255, 0.16)',
    'rgba(204, 204, 204, 0.78)', 'rgba(204, 204, 204, 0.05)',
    'rgba(24, 26, 31, 0.85)', 'rgba(125, 145, 170, 0.5)', 'rgba(150, 172, 200, 0.7)',
    'rgba(0, 0, 0, 0.45)', 'rgba(59, 142, 234, 0.2)'
  ]),
  // Background-image iron laws: dark dock backing #0d1117, dim scrim #000,
  // transparent xterm bg #00000000, deliberate dark dead-process scrim.
  'terminal/terminal.css': new Set(['#0d1117', '#00000000', '#000', '#fff', 'rgba(0, 0, 0, 0.55)'])
}
/** values allowed inside var(x, <fallback>) — the historical literal set. */
const FALLBACK_OK = new Set([
  '#cccccc', '#8a8a8a', '#9a9a9a', '#6a6a6a', '#d0d0d0', '#ffffff', '#fff', '#000', '#000000',
  '#3fb950', '#f85149', '#cf6679', '#ff6b6b', '#ff4d4f', '#d29922', '#e3b341', '#f0a55a',
  '#f2cc60', '#4cc38a', '#6aa9ff', '#3fd06a', '#58a6ff', '#3b8eea', '#1f1f1f', '#0d1117',
  '#f5f5f5', '#252525', '#2d2d2d', '#181818', '#101418',
  '#e8e8e8', '#10141a', '#98a2ab', '#4ad476', '#46c96a',
  'rgba(255, 255, 255, 0.04)', 'rgba(255, 255, 255, 0.05)', 'rgba(255, 255, 255, 0.07)',
  'rgba(255, 255, 255, 0.08)', 'rgba(255, 255, 255, 0.1)', 'rgba(255, 255, 255, 0.16)',
  'rgba(255, 255, 255, 0.2)', 'rgba(255, 255, 255, 0.24)', 'rgba(255, 255, 255, 0.45)',
  'rgba(255, 255, 255, 0.55)', 'rgba(255, 255, 255, 0.85)', 'rgba(255, 255, 255, 0.88)',
  'rgba(0, 0, 0, 0.06)', 'rgba(0, 0, 0, 0.14)', 'rgba(0, 0, 0, 0.22)',
  'rgba(0, 0, 0, 0.28)', 'rgba(0, 0, 0, 0.4)', 'rgba(0, 0, 0, 0.45)', 'rgba(0, 0, 0, 0.55)',
  'rgba(24, 26, 31, 0.85)', 'rgba(125, 145, 170, 0.5)', 'rgba(150, 172, 200, 0.7)',
  'rgba(59, 142, 234, 0.18)', 'rgba(59, 142, 234, 0.2)', 'rgba(59, 142, 234, 0.75)',
  'rgba(148, 163, 184, 0.28)', 'rgba(121, 121, 121, 0.45)', 'rgba(90, 93, 94, 0.31)'
])

function walk(dir, out = []) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f)
    if (fs.statSync(p).isDirectory()) walk(p, out)
    else if (/\.(css|tsx|ts)$/.test(f)) out.push(p)
  }
  return out
}
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/.*$/gm, '$1')
/** hex + the functional colour notations.
 *  CASE-SENSITIVE on purpose: with an `i` flag `rgb(` also matches
 *  `Rgb(hex: string)` — a TypeScript type annotation, not a colour. */
const COLOR =
  /#[0-9a-fA-F]{3,8}\b(?![-\w])|rgba?\([^)]*\)|hsla?\([^)]*\)|oklch\([^)]*\)|(?:ok)?lab\([^)]*\)|lch\([^)]*\)/g
/** The CSS named colours. Case-insensitive (CSS keywords are), but ONLY in a
 *  value position — and never as a property name:
 *   - the lookbehind puts it after `:` / `,` / `(` or at the start of a
 *     declaration, so prose in a string is not a hit;
 *   - the trailing (?![\-\w]) keeps `white-space: nowrap` from matching the
 *     "white" in the property NAME. Without it that one property alone
 *     produces 60 false positives across the renderer.
 *  Measured on this repo: the naive named-colour regex (no guards) reports 183
 *  hits, of which 86 are `white-space`; with both guards it reports 0. */
const NAMED_COLOR =
  /(?<=^|[:(,]\s*|\s)(?:red|green|blue|black|white|gray|grey|yellow|orange|purple|pink|cyan|magenta|brown|silver|gold|beige|ivory|khaki|lime|maroon|navy|olive|teal|tomato|violet|aqua|coral|crimson|indigo|lavender|plum|orchid|salmon|sienna|tan|wheat|azure)\b(?![\-\w])/gi

let violations = 0
for (const file of walk(ROOT)) {
  const rel = path.relative(ROOT, file).split(path.sep).join('/')
  const wl = WHITELIST[rel]
  if (wl === null) continue
  const raw = stripComments(fs.readFileSync(file, 'utf8'))
  // A template literal that INTERPOLATES may build a colour from variables
  // (MonitorPanel's withAlpha constructs rgba() from a resolved hex) and
  // carries no literal to police. A template literal with no interpolation is
  // just a string — its contents are still a literal.
  const outsideVar = raw
    .replace(/var\([^)]*\)/g, '()')
    .replace(/`(?:[^`\\]|\\.)*\$\{[^}]*\}(?:[^`\\]|\\.)*`/g, '()')
  const lines = outsideVar.split(/\r?\n/)
  lines.forEach((line, idx) => {
    for (const m of line.matchAll(COLOR)) {
      const lit = m[0].toLowerCase()
      if (wl && wl.has(lit)) continue
      console.error(`RAW ${rel}:${idx + 1}: ${lit}`)
      violations++
    }
    for (const m of line.matchAll(NAMED_COLOR)) {
      const lit = m[0].toLowerCase()
      if (wl && wl.has(lit)) continue
      console.error(`RAW ${rel}:${idx + 1}: ${lit}`)
      violations++
    }
  })
  for (const v of raw.matchAll(/var\(([^)]*)\)/g)) {
    let fb = v[1].split(',').slice(1).join(',').trim()
    if (!fb || fb.startsWith('var(')) continue
    // var(a, rgba(...)) — the [^)]* capture stops at rgba's ')'; restore it
    if (fb.startsWith('rgb') && !fb.endsWith(')')) fb += ')'
    for (const lit of fb.match(COLOR) ?? []) {
      if (!FALLBACK_OK.has(lit.toLowerCase())) {
        console.error(`FALLBACK ${rel}: var(${v[1]}) -> ${lit}`)
        violations++
      }
    }
  }
}
// Negative self-test: the matcher must catch literals incl. 3/4-digit hex
{
  const probe = stripComments('.a{color:#fff9;border:#abcd}')
  const hits = [...probe.matchAll(COLOR)].length
  if (hits < 2) {
    console.error('self-test failed: matcher did not catch probe literals')
    process.exit(1)
  }
}
// Negative self-test: the families that used to pass the scanner.
{
  // The named colour is case-insensitive (CSS keywords are), the functional
  // notations are NOT (see the two-regex split below).
  const families = [
    ['a named colour', '.a{color:red}', 'red', 'named'],
    ['an hsl() colour', '.a{color:hsl(0,100%,50%)}', 'hsl(0,100%,50%)', 'func'],
    ['an hsla() colour', '.a{color:hsla(0,100%,50%,0.5)}', 'hsla(0,100%,50%,0.5)', 'func'],
    ['an oklch() colour', '.a{color:oklch(0.7 0.1 200)}', 'oklch(0.7 0.1 200)', 'func'],
    ['a lab() colour', '.a{color:lab(50% 40 59)}', 'lab(50% 40 59)', 'func'],
    ['a lch() colour', '.a{color:lch(50% 40 59)}', 'lch(50% 40 59)', 'func']
  ]
  for (const [label, source, literal, kind] of families) {
    const re = kind === 'named' ? NAMED_COLOR : COLOR
    const hits = [...stripComments(source).matchAll(re)].map((m) => m[0].toLowerCase())
    if (!hits.includes(literal)) {
      console.error(`self-test failed: matcher did not catch ${label} (${literal})`)
      process.exit(1)
    }
  }
}
// Negative self-test: a color-mix() body must not hide its own literals.
{
  const body = 'color-mix(in srgb, #ff0000 50%, transparent)'
  const hits = [...stripComments(`.a{${body}}`).matchAll(COLOR)].map((m) => m[0].toLowerCase())
  if (!hits.includes('#ff0000')) {
    console.error('self-test failed: matcher did not catch a hex inside color-mix()')
    process.exit(1)
  }
}
// Negative self-test: a functional notation must NOT match a TypeScript type
// annotation. The `i` flag on a combined regex makes `rgb(` match `Rgb(hex:
// string)` — which is why the functional notations stay case-sensitive.
{
  const hits = [...stripComments('const f = (x: Rgb(hex: string)) => x').matchAll(COLOR)]
  if (hits.length > 0) {
    console.error('self-test failed: the matcher caught a TypeScript type annotation')
    process.exit(1)
  }
}
if (violations > 0) {
  console.error(`css-theme-vars: ${violations} violation(s)`)
  process.exit(1)
}
console.log('css-theme-vars: all ok')
