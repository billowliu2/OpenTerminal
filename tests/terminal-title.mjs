/**
 * Auto terminal-title self-test (terminal-title.mjs).
 *
 * A local terminal's tab title is stored DISPLAY text — it rides along in
 * layout templates, the session snapshot and the broadcast registry — so it
 * outlives the language it was written in. `src/shared/terminalTitle.ts` is the
 * one place that reads the number back out of such a title and that renders a
 * fresh one, and both directions have to agree with all four dictionaries:
 *
 *   - a title written in ANY language resolves to its number, so a workspace
 *     created in 简体中文 keeps counting correctly after the user switches to
 *     日本語 (and the numbers fill the lowest free gap);
 *   - rendering follows the ACTIVE language, which is what makes a language
 *     switch re-render "终端 3" as "Terminal 3";
 *   - a title that matches no language's pattern is the user's own and must
 *     never be resolved (a false positive would rename it on a language switch).
 *
 * The expected patterns are written out here rather than read from the module
 * under test, so a dictionary that drifts from both would fail instead of
 * agreeing with itself.
 *
 * Build: node tests/build-bundles.cjs
 * Run:   node tests/.terminal-title.cjs   (must exit 0)
 */
import {
  autoTerminalTitleNumber,
  nextTerminalTitle,
  renderTerminalTitle,
  retitleAutoTitles
} from '../src/shared/terminalTitle.ts'
import { setLanguage, t } from '../src/shared/i18n/index.ts'

let failed = 0
const ok = (cond, msg) => {
  console.log(`  ${cond ? 'ok' : 'FAIL'}: ${msg}`)
  if (!cond) failed += 1
}

const LANGUAGES = ['zh-CN', 'zh-TW', 'en', 'ja']

const PATTERN = {
  'zh-CN': '终端 {n}',
  'zh-TW': '終端機 {n}',
  en: 'Terminal {n}',
  ja: 'ターミナル {n}'
}

const title = (lang, n) => PATTERN[lang].replace('{n}', String(n))

console.log('the four dictionaries still carry the patterns this table is built from')
for (const lang of LANGUAGES) {
  setLanguage(lang)
  ok(
    t('workspace.tab.terminalTitle', { n: 7 }) === title(lang, 7),
    `${lang}: ${JSON.stringify(title(lang, 7))}`
  )
}

console.log('rendering follows the ACTIVE language')
for (const lang of LANGUAGES) {
  setLanguage(lang)
  ok(renderTerminalTitle(3) === title(lang, 3), `${lang}: renderTerminalTitle(3) = ${JSON.stringify(title(lang, 3))}`)
  setLanguage(lang)
  ok(nextTerminalTitle([]) === title(lang, 1), `${lang}: an empty workspace starts at ${JSON.stringify(title(lang, 1))}`)
}

console.log('every writer/reader language pair resolves')
for (const writer of LANGUAGES) {
  for (const reader of LANGUAGES) {
    setLanguage(reader)
    const written = title(writer, 12)
    ok(
      autoTerminalTitleNumber(written) === 12,
      `${writer} title resolves while the UI is ${reader}: ${JSON.stringify(written)}`
    )
  }
}

console.log('numbering is language-independent, so a switch keeps the count')
setLanguage('en')
ok(
  nextTerminalTitle(['终端 1', '終端機 2', 'Terminal 3', 'ターミナル 4']) === 'Terminal 5',
  'one title per language still occupies its own number'
)
ok(nextTerminalTitle(['终端 3']) === 'Terminal 1', 'the lowest free number wins, not the highest used')
ok(nextTerminalTitle(['终端 1', 'Terminal 2']) === 'Terminal 3', 'the first gap is filled')
ok(nextTerminalTitle(['终端 2', 'Terminal 3']) === 'Terminal 1', 'a hole below the used range is filled')
ok(nextTerminalTitle(['Terminal 5']) === 'Terminal 1', 'a lone high number does not push the counter up')
setLanguage('ja')
ok(nextTerminalTitle(['终端 3']) === 'ターミナル 1', 'numbering renders in the language that is active now')

console.log('user-authored titles are never resolved')
const notAuto = [
  // The match is anchored and both literals must be exact.
  '终端机 3', // 简体 "machine": one character away from 繁體 "終端機"
  '終端機3', // missing the space
  '终端 3 号',
  '终端  3', // double space
  ' 终端 3', // leading space
  '终端 3 ', // trailing space
  'My Terminal 4',
  'Terminal',
  'Terminal ',
  'Terminal #3',
  'x Terminal 3',
  'Terminal 3x',
  'ターミナル 3 番',
  'Terminal 007', // the app never renders leading zeros
  '终端 -3',
  '终端 3.5',
  '',
  '終端機 ٣' // Arabic-Indic digit
]
for (const s of notAuto) {
  const n = autoTerminalTitleNumber(s)
  ok(n === undefined, `not auto: ${JSON.stringify(s)} (got ${String(n)})`)
}

console.log('degenerate input neither throws nor resolves')
for (const s of [undefined, null, 'Terminal 3'.repeat(400)]) {
  let threw = false
  let n
  try {
    n = autoTerminalTitleNumber(s)
  } catch {
    threw = true
  }
  ok(!threw && n === undefined, `safe on ${JSON.stringify(s)?.slice(0, 24) ?? String(s)}`)
}

console.log('a language switch retitles exactly the auto titles')
/** Minimal stand-in for a dockview panel, so the retitle pass runs unchanged. */
const fakePanel = (title) => {
  const panel = { title, written: [] }
  panel.setTitle = (next) => {
    panel.written.push(next)
    panel.title = next
  }
  return panel
}
const runRetitle = (lang, titles) => {
  setLanguage(lang)
  const panels = titles.map(fakePanel)
  const changed = retitleAutoTitles(panels)
  return { changed, titles: panels.map((p) => p.title), writes: panels.map((p) => p.written.length) }
}

ok(
  JSON.stringify(runRetitle('en', ['终端 1', '終端機 2', 'Terminal 3', 'ターミナル 4'])) ===
    JSON.stringify({ changed: 3, titles: ['Terminal 1', 'Terminal 2', 'Terminal 3', 'Terminal 4'], writes: [1, 1, 0, 1] }),
  'each old-language title is rewritten; one already in the active language is not'
)
ok(
  JSON.stringify(runRetitle('ja', ['终端 3', 'My Terminal 4', 'x Terminal 5', 'Terminal'])) ===
    JSON.stringify({ changed: 1, titles: ['ターミナル 3', 'My Terminal 4', 'x Terminal 5', 'Terminal'], writes: [1, 0, 0, 0] }),
  'user titles survive a language switch untouched'
)
ok(
  JSON.stringify(runRetitle('zh-TW', ['Terminal 7'])) ===
    JSON.stringify({ changed: 1, titles: ['終端機 7'], writes: [1] }),
  'the number is preserved across the switch'
)
ok(runRetitle('en', []).changed === 0, 'an empty panel list is a no-op')
ok(
  runRetitle('en', ['终端 1', 'Terminal 1']).changed === 1,
  'two spellings of number 1 are re-rendered to one title without renumbering'
)

if (failed > 0) {
  console.error(`\n[terminal-title] ${failed} check(s) FAILED`)
  process.exit(1)
}
console.log('\n[terminal-title] ALL CHECKS PASSED')
