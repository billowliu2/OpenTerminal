/**
 * Preset highlight-rule self-test (hl-rules.mjs).
 *
 * The shipped presets are regexes over arbitrary program output, so their word
 * boundaries are the whole game: `invalid` must not light up `valid`,
 * `disabled` must not light up `enabled`, and the `ok` in `not ok` must stay out
 * of the success rule. Every assertion goes through the real engine, so it also
 * covers the ANSI wrapping a terminal actually receives.
 *
 * Build + run:
 *   npx esbuild tests/hl-rules.mjs --bundle --platform=node --format=cjs \
 *     --outfile=tests/.hl-rules.cjs --alias:@shared=./src/shared
 *   node tests/hl-rules.mjs
 */
import { compileRules, applyHighlights } from '../src/renderer/src/terminal/highlightEngine.ts'
import { previewSpans } from '../src/renderer/src/terminal/highlightEngine.ts'
import { DEFAULT_HIGHLIGHT_RULES } from '../src/shared/settings.ts'
import { exportHighlightRules, mergeRules, parseHighlightRules } from '../src/shared/highlightIO.ts'
import {
  excludedByProfile,
  rulesForProfile,
  sanitizeProfiles
} from '../src/shared/highlightProfiles.ts'
import {
  applyThemeColors,
  paletteMatch,
  themeColorFor
} from '../src/renderer/src/theme/highlightColors.ts'

let failed = 0
const ok = (cond, msg) => {
  console.log(`  ${cond ? 'ok' : 'FAIL'}: ${msg}`)
  if (!cond) failed++
}

const rules = compileRules(DEFAULT_HIGHLIGHT_RULES)

/** truecolor prefix for a hex colour, as the engine emits it */
const sgr = (hex) => {
  const n = parseInt(hex.slice(1), 16)
  return `\x1b[38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}m`
}
const OK_GREEN = '#3fb950'
const BAD_RED = '#f85149'
const WARN_YELLOW = '#e3b341'
const DANGER_RED = '#ff7b72'
const DEL_ORANGE = '#ffa657'
const NEW_GREEN = '#56d364'

/** true when `word` comes back from `text` wrapped in `hex` */
const colored = (text, hex, word) => applyHighlights(text, rules).includes(`${sgr(hex)}${word}\x1b[0m`)

// ---- 1. presets compile at all ----------------------------------------------
console.log('[presets]')
{
  ok(
    rules.length === DEFAULT_HIGHLIGHT_RULES.length,
    `every preset rule compiles (${rules.length}/${DEFAULT_HIGHLIGHT_RULES.length})`
  )
  const ids = DEFAULT_HIGHLIGHT_RULES.map((r) => r.id)
  ok(new Set(ids).size === ids.length, 'preset ids are unique')
  const bad = DEFAULT_HIGHLIGHT_RULES.filter((r) => !/^#[0-9a-fA-F]{6}$/.test(r.color.fg))
  ok(bad.length === 0, 'every preset has a #rrggbb foreground colour')
  const statuses = ['okstate', 'warnstate', 'badstate', 'danger']
  ok(
    statuses.every((id) => DEFAULT_HIGHLIGHT_RULES.find((r) => r.id === id)?.caseInsensitive === true),
    'status presets match case-insensitively'
  )
}

// ---- 2. success words, in any case ------------------------------------------
console.log('[success]')
{
  const words = [
    'SUCCESS',
    'Success',
    'success',
    'successful',
    'succeeded',
    'SUCCEEDS',
    'PASS',
    'passed',
    'Passes',
    'ok',
    'Ok',
    'OK',
    'okay',
    'done',
    'DONE',
    'finished',
    'complete',
    'completed',
    'good',
    'Good',
    'GOOD',
    'fine',
    'true',
    'enabled',
    'active',
    'online',
    'ready',
    'healthy',
    'matched',
    'found',
    'accepted',
    'approved',
    'valid',
    'allowed'
  ]
  const missed = words.filter((w) => !colored(`${w} 1`, OK_GREEN, w))
  ok(missed.length === 0, `all success words highlight (missed: ${missed.join(', ') || 'none'})`)
}

// ---- 3. failure words, in any case ------------------------------------------
console.log('[failure]')
{
  const words = [
    'ERROR',
    'error',
    'Error',
    'ERR',
    'err',
    'errno',
    'NG',
    'ng',
    'BUG',
    'bug',
    'buggy',
    'FAILED',
    'failed',
    'FAILURE',
    'fatal',
    'CRITICAL',
    'critical',
    'PANIC',
    'exception',
    'Traceback',
    'aborted',
    'crashed',
    'segfault',
    'denied',
    'refused',
    'rejected',
    'invalid',
    'illegal',
    'mismatch',
    'timeout',
    'unreachable',
    'unhealthy',
    'conflict',
    'corrupted',
    'missing',
    'bad',
    'wrong',
    'offline'
  ]
  const missed = words.filter((w) => !colored(`${w} 1`, BAD_RED, w))
  ok(missed.length === 0, `all failure words highlight (missed: ${missed.join(', ') || 'none'})`)

  // negated success words belong to the failure rule as a whole phrase
  for (const phrase of ['not ok', 'NOT OK', 'not done', 'not found', 'Not Passed']) {
    ok(colored(`${phrase} 1`, BAD_RED, phrase), `"${phrase}" highlights as a failure`)
  }
}

// ---- 4. warnings ------------------------------------------------------------
console.log('[warning]')
{
  const words = ['WARN', 'warn', 'WARNING', 'Warnings', 'caution', 'notice', 'DEPRECATED', 'TODO', 'FIXME']
  const missed = words.filter((w) => !colored(`${w} 1`, WARN_YELLOW, w))
  ok(missed.length === 0, `all warning words highlight (missed: ${missed.join(', ') || 'none'})`)
  ok(!colored('warning 1', BAD_RED, 'warning'), 'a warning is not also painted as an error')
}

// ---- 5. status symbols (checks, crosses, warning sign) ----------------------
console.log('[symbols]')
{
  const glyphs = [
    ['\u2713', OK_GREEN], // ✓ check mark
    ['\u2714', OK_GREEN], // ✔ heavy check mark
    ['\u2705', OK_GREEN], // ✅ white heavy check mark
    ['\u2717', BAD_RED], // ✗ ballot x
    ['\u2718', BAD_RED], // ✘ heavy ballot x
    ['\u2716', BAD_RED], // ✖ heavy multiplication x
    ['\u274C', BAD_RED], // ❌ cross mark
    ['\u26A0', WARN_YELLOW] // ⚠ warning sign
  ]
  const missed = glyphs.filter(([glyph, hex]) => !colored(`build ${glyph} ok`, hex, glyph))
  ok(
    missed.length === 0,
    `every status symbol highlights (missed: ${missed.map(([g]) => g).join(' ') || 'none'})`
  )
  // an emoji variation selector rides along inside the coloured span
  ok(
    colored('build \u2705\uFE0F ok', OK_GREEN, '\u2705\uFE0F'),
    'the emoji variation selector stays inside the coloured span'
  )
  // the two families never cross over
  ok(!colored('\u2713', BAD_RED, '\u2713'), 'a check mark is never painted as a failure')
  ok(!colored('\u2717', OK_GREEN, '\u2717'), 'a cross mark is never painted as a success')
}

// ---- 6. no false positives inside longer words ------------------------------
console.log('[word boundaries]')
{
  const cases = [
    ['valid', 'invalid', OK_GREEN],
    ['enabled', 'disabled', OK_GREEN],
    ['active', 'inactive', OK_GREEN],
    ['healthy', 'unhealthy', OK_GREEN],
    ['pass', 'passwd', OK_GREEN],
    ['passed', 'bypassed', OK_GREEN],
    ['found', 'foundation', OK_GREEN],
    ['ok', 'okapi', OK_GREEN],
    ['fine', 'define', OK_GREEN]
  ]
  for (const [inner, word, hex] of cases) {
    ok(!colored(word, hex, inner), `"${word}" does not highlight the "${inner}" inside it`)
  }
  ok(!colored('not ok', OK_GREEN, 'ok'), 'the ok in "not ok" is never green')
  ok(!colored('not ok', OK_GREEN, 'not ok'), '"not ok" is not green as a whole phrase')
}

// ---- 7. destructive commands ------------------------------------------------
console.log('[danger]')
{
  const cases = [
    'rm -rf /tmp/x',
    'sudo rm -fr build',
    'mkfs.ext4 /dev/sdb1',
    'dd if=/dev/zero of=/dev/sda',
    'git reset --hard HEAD~3',
    'git push --force',
    'drop table users'
  ]
  const missed = cases.filter((c) => !applyHighlights(c, rules).includes(sgr(DANGER_RED)))
  ok(missed.length === 0, `destructive commands are flagged (missed: ${missed.join(' | ') || 'none'})`)

  // ...while ordinary output that merely contains such letters is left alone
  const quiet = ['reformat the disk image', 'the alarm was halted', 'remember to remount it']
  const wrong = quiet.filter((t) => applyHighlights(t, rules).includes(sgr(DANGER_RED)))
  ok(
    wrong.length === 0,
    `non-command text is not flagged (flagged: ${wrong.join(' | ') || 'none'})`
  )
}

// ---- 8. case-insensitive flag is opt-in per rule ----------------------------
console.log('[case flag]')
{
  const plain = compileRules([
    { id: 'cs', pattern: '\\bERROR\\b', enabled: true, priority: 1, color: { fg: BAD_RED } }
  ])
  ok(!applyHighlights('error', plain).includes(sgr(BAD_RED)), 'a rule without the flag still respects case')
  const folded = compileRules([
    { id: 'ci', pattern: '\\bERROR\\b', enabled: true, priority: 1, color: { fg: BAD_RED }, caseInsensitive: true }
  ])
  ok(applyHighlights('error', folded).includes(sgr(BAD_RED)), 'the flag makes a rule case-insensitive')
}

// ---- 9. file operations (create vs delete) ---------------------------------
console.log('[file ops]')
{
  const deleted = [
    'delete',
    'deleted',
    'Deleted',
    'deleting',
    'remove',
    'removed',
    'removal',
    'rm',
    'rmdir',
    'unlink',
    'purge',
    'DESTROYED',
    'truncate',
    'wipe',
    'revoked',
    'unmounted',
    'killed',
    'drop',
    'dropped',
    'cleanup',
    'moved',
    'renamed',
    'overwritten'
  ]
  const missedDelete = deleted.filter((w) => !colored(`${w} 1`, DEL_ORANGE, w))
  ok(
    missedDelete.length === 0,
    `delete/side-effect words highlight (missed: ${missedDelete.join(', ') || 'none'})`
  )

  const created = [
    'create',
    'created',
    'Created',
    'creating',
    'creation',
    'mkdir',
    'touch',
    'add',
    'added',
    'Added',
    'install',
    'installed',
    'clone',
    'cloned',
    'generate',
    'generated',
    'init',
    'initialized',
    'import',
    'upload',
    'downloaded',
    'saved',
    'wrote',
    'written',
    'mounted'
  ]
  const missedCreate = created.filter((w) => !colored(`${w} 1`, NEW_GREEN, w))
  ok(
    missedCreate.length === 0,
    `create/install words highlight (missed: ${missedCreate.join(', ') || 'none'})`
  )

  // neighbours that merely contain the letters stay untouched
  for (const [text, hex, inner] of [
    ['address', NEW_GREEN, 'add'],
    ['initial', NEW_GREEN, 'init'],
    ['movie', DEL_ORANGE, 'move'],
    ['form', DEL_ORANGE, 'rm'],
    ['keeper', DEL_ORANGE, 'keep']
  ]) {
    ok(!colored(text, hex, inner), `"${text}" does not highlight the "${inner}" inside it`)
  }

  // silent-e stems: delete→deleting, save→saving, create→creating. These are the
  // forms a naive `DELETE(?:D|S|ING)?` misses, so they get their own sweep.
  const gerunds = [
    ['deleting', DEL_ORANGE],
    ['moving', DEL_ORANGE],
    ['renaming', DEL_ORANGE],
    ['truncating', DEL_ORANGE],
    ['erasing', DEL_ORANGE],
    ['purging', DEL_ORANGE],
    ['wiping', DEL_ORANGE],
    ['revoking', DEL_ORANGE],
    ['terminating', DEL_ORANGE],
    ['creating', NEW_GREEN],
    ['cloning', NEW_GREEN],
    ['saving', NEW_GREEN],
    ['generating', NEW_GREEN],
    ['initializing', NEW_GREEN],
    ['installing', NEW_GREEN],
    ['adds', NEW_GREEN],
    ['completing', OK_GREEN],
    ['succeeding', OK_GREEN],
    ['passing', OK_GREEN],
    ['finishing', OK_GREEN],
    ['enabling', OK_GREEN],
    ['failing', BAD_RED],
    ['aborting', BAD_RED],
    ['crashing', BAD_RED],
    ['refusing', BAD_RED],
    ['corrupting', BAD_RED]
  ]
  const missedForms = gerunds.filter(([w, hex]) => !colored(`${w} 1`, hex, w))
  ok(
    missedForms.length === 0,
    `inflected forms highlight (missed: ${missedForms.map(([w]) => w).join(', ') || 'none'})`
  )

  // the two families never cross over, and danger still owns destructive commands
  ok(!colored('deleted 1', NEW_GREEN, 'deleted'), 'a delete word is never painted as a create')
  ok(!colored('created 1', DEL_ORANGE, 'created'), 'a create word is never painted as a delete')
  ok(
    applyHighlights('drop table users', rules).includes(sgr(DANGER_RED)),
    'danger still claims "drop table" ahead of the delete rule'
  )
  ok(
    applyHighlights('export PATH=/usr/bin:$PATH', rules).includes(sgr('#d2a8ff')),
    'export stays a shell keyword, not a file operation'
  )
}

// ---- 10. value bands (percentages) -----------------------------------------
console.log('[value bands]')
{
  const BAND_LIGHT_GREEN = '#7ee787'
  const at = (value) => applyHighlights(`${value}% done`, rules)
  const expected = [
    ['0', BAD_RED],
    ['5', BAD_RED],
    ['19', BAD_RED],
    ['19.9', BAD_RED],
    ['20', WARN_YELLOW],
    ['35', WARN_YELLOW],
    ['49.9', WARN_YELLOW],
    ['50', BAND_LIGHT_GREEN],
    ['79', BAND_LIGHT_GREEN],
    ['80', OK_GREEN],
    ['99', OK_GREEN],
    ['100', OK_GREEN]
  ]
  const wrong = expected.filter(([value, hex]) => !at(value).includes(`${sgr(hex)}${value}%\x1b[0m`))
  ok(
    wrong.length === 0,
    `percentages pick their band by value (wrong: ${wrong.map(([v]) => `${v}%`).join(', ') || 'none'})`
  )

  // a rule without bands keeps one colour whatever the number
  const flat = compileRules([
    { id: 'flat', pattern: '\\d+%', enabled: true, priority: 1, color: { fg: BAD_RED } }
  ])
  ok(applyHighlights('77%', flat).includes(sgr(BAD_RED)), 'a rule without bands stays flat')

  // with bands: the match's own number decides, and no number falls back
  const banded = compileRules([
    {
      id: 'banded',
      pattern: '\\bDONE\\b|\\d+%',
      enabled: true,
      priority: 1,
      color: { fg: OK_GREEN },
      bands: [
        { min: 0, fg: BAD_RED },
        { min: 90, fg: OK_GREEN }
      ]
    }
  ])
  ok(applyHighlights('DONE', banded).includes(sgr(OK_GREEN)), 'no number in the match → the rule colour')
  ok(applyHighlights('5%', banded).includes(sgr(BAD_RED)), 'a number below the second band → the first band')
  ok(applyHighlights('95%', banded).includes(sgr(OK_GREEN)), 'a number above the last min → the last band')

  // bands stored out of order still resolve lowest-first
  const unsorted = compileRules([
    {
      id: 'unsorted',
      pattern: '\\d+%',
      enabled: true,
      priority: 1,
      color: { fg: OK_GREEN },
      bands: [
        { min: 80, fg: OK_GREEN },
        { min: 0, fg: BAD_RED },
        { min: 50, fg: BAND_LIGHT_GREEN }
      ]
    }
  ])
  ok(
    applyHighlights('10%', unsorted).includes(sgr(BAD_RED)) &&
      applyHighlights('60%', unsorted).includes(sgr(BAND_LIGHT_GREEN)) &&
      applyHighlights('90%', unsorted).includes(sgr(OK_GREEN)),
    'bands are applied lowest-first regardless of stored order'
  )
}

// ---- 11. log levels, exit codes, HTTP codes, durations, secrets -------------
console.log('[ops & levels]')
{
  const LOG_BLUE = '#79c0ff'
  const ROOT_ORANGE = '#ffa657'
  const HTTP_GRAY = '#8b949e'

  for (const word of ['INFO', 'DEBUG', 'TRACE', 'VERBOSE']) {
    ok(colored(`${word} starting up`, LOG_BLUE, word), `"${word}" highlights as a log level`)
  }
  ok(!colored('for more information see docs', LOG_BLUE, 'INFO'), 'lowercase "information" is not a log level')
  // NOTICE belongs to the warning rule (it is a warning level), not this one
  ok(colored('NOTICE disk almost full', WARN_YELLOW, 'NOTICE'), 'NOTICE stays with the warning rule')

  ok(colored('root@web01:~# ls', ROOT_ORANGE, 'root@web01'), 'a root prompt is flagged')
  ok(!colored('admin@web01:~$ ls', ROOT_ORANGE, 'admin@web01'), 'a normal user prompt is not')

  ok(colored('exit code 0', OK_GREEN, 'exit code 0'), 'a zero exit code is green')
  ok(colored('Process exited with code 1', BAD_RED, 'exited with code 1'), 'a non-zero exit code is red')
  ok(colored('exit 2', BAD_RED, 'exit 2'), 'a bare "exit 2" is red')

  ok(colored('HTTP/1.1 404 Not Found', WARN_YELLOW, '404'), 'a 4xx code is yellow')
  ok(
    !applyHighlights('HTTP/1.1 404 Not Found', rules).includes(`${sgr(WARN_YELLOW)}1.1`),
    'the HTTP version is not swept into the status-code span'
  )
  ok(colored('status: 500', BAD_RED, '500'), 'status: 500 is red')
  ok(colored('status 201', OK_GREEN, '201'), 'status 201 is green')
  ok(colored('301 Moved Permanently', '#58a6ff', '301'), 'a 3xx with its reason phrase is blue')
  ok(colored('204 No Content', OK_GREEN, '204'), '204 No Content is green')
  ok(colored('HTTP/2 100', HTTP_GRAY, '100'), 'a 1xx code is grey')
  ok(
    !applyHighlights('processed 404 items', rules).includes(sgr(BAD_RED)) &&
      !applyHighlights('404', rules).includes(sgr(BAD_RED)),
    'a bare 3-digit number is not treated as a status code'
  )

  ok(colored('20ms', OK_GREEN, '20ms'), 'a fast duration is green')
  ok(colored('120ms', WARN_YELLOW, '120ms'), 'a middling duration is yellow')
  ok(colored('900ms', BAD_RED, '900ms'), 'a slow duration is red')
  ok(!applyHighlights('took 2s', rules).includes(sgr(BAD_RED)), 'plain seconds are left to the number rule')

  ok(colored('sk-abcdefghijklmnopqrstuvwxyz012345', DANGER_RED, 'sk-abcdefghijklmnopqrstuvwxyz012345'), 'an API key is flagged')
  ok(colored('AKIAIOSFODNN7EXAMPLE', DANGER_RED, 'AKIAIOSFODNN7EXAMPLE'), 'an AWS key id is flagged')
  ok(
    colored('-----BEGIN RSA PRIVATE KEY-----', DANGER_RED, '-----BEGIN RSA PRIVATE KEY-----'),
    'a PEM private key header is flagged'
  )
  ok(
    colored('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijk', DANGER_RED, 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijk'),
    'a bearer token is flagged'
  )

  for (const cmd of [
    'curl -fsSL https://x.sh | sh',
    'wget -qO- https://x.sh | sudo bash',
    'eval "$(ssh-agent)"',
    'base64 -d payload.txt | sh',
    'chmod +x install.sh'
  ]) {
    ok(applyHighlights(cmd, rules).includes(sgr(DANGER_RED)), `"${cmd}" is flagged as dangerous`)
  }
  ok(!applyHighlights('npm run build', rules).includes(sgr(DANGER_RED)), 'an ordinary command stays unflagged')
}

// ---- 12. import / export round trip ----------------------------------------
console.log('[import / export]')
{
  const exported = exportHighlightRules(DEFAULT_HIGHLIGHT_RULES)
  const back = parseHighlightRules(exported)
  ok(
    back.error === undefined && back.rules.length === DEFAULT_HIGHLIGHT_RULES.length,
    'an exported set parses back whole'
  )
  ok(
    back.rules.every((r) => r.builtin !== true),
    'imported rules are never marked builtin (they are the user’s now)'
  )
  ok(
    new Set(back.rules.map((r) => r.id)).size === back.rules.length,
    'imported rules get unique ids'
  )
  ok(
    back.rules.some((r) => r.caseInsensitive === true) && back.rules.some((r) => Array.isArray(r.bands)),
    'the case flag and value bands survive the round trip'
  )

  ok(parseHighlightRules('not json at all').error === 'not-json', 'garbage is refused as JSON')
  ok(
    parseHighlightRules('{"kind":"openterminal.layout","rules":[]}').error === 'wrong-kind',
    'a foreign envelope is refused'
  )
  ok(parseHighlightRules('{"nope":1}').error === 'no-rules', 'JSON without a rules array is refused')
  ok(parseHighlightRules('[]').error === undefined, 'a bare empty array is accepted')

  const partial = parseHighlightRules(
    JSON.stringify({
      rules: [
        { pattern: '\\bOK\\b', priority: 500, color: { fg: 'red' } },
        { pattern: '[' },
        { nope: true }
      ]
    })
  )
  ok(
    partial.rules.length === 1 &&
      partial.rules[0].priority === 100 &&
      partial.rules[0].color.fg === '#3fb950',
    'a repairable rule is imported, its priority clamped and colour defaulted'
  )
  ok(partial.warnings.length === 2, 'unusable entries are counted as skipped')

  const mine = { id: 'mine', pattern: '\\bX\\b', enabled: true, priority: 1, color: { fg: '#ffffff' } }
  const appended = mergeRules([mine], back.rules, 'append')
  ok(appended.length === DEFAULT_HIGHLIGHT_RULES.length + 1, 'append keeps the existing rules')
  ok(new Set(appended.map((r) => r.id)).size === appended.length, 'append never leaves duplicate ids')
  ok(mergeRules([mine], back.rules, 'replace').length === DEFAULT_HIGHLIGHT_RULES.length, 'replace drops the old set')
}

// ---- 13. editor preview spans ----------------------------------------------
console.log('[preview]')
{
  const spans = previewSpans('SUCCESS 85% ERROR', rules)
  ok(spans.map((s) => s.text).join('') === 'SUCCESS 85% ERROR', 'preview spans reassemble the input exactly')
  ok(spans.some((s) => s.text === 'SUCCESS' && s.fg === OK_GREEN), 'a preview span carries its colour')
  ok(spans.some((s) => s.text === 'ERROR' && s.fg === BAD_RED), 'a failure span carries its colour too')
  ok(
    spans.some((s) => s.text === '85%' && s.fg === OK_GREEN),
    'the preview honours value bands (85% is in the green band)'
  )
  ok(
    previewSpans('\x1b[31mERROR\x1b[0m', rules).map((s) => s.text).join('') === 'ERROR',
    'escape sequences in the sample are stripped before previewing'
  )
  ok(previewSpans('nothing here', []).length === 1, 'no rules → the sample stays one plain span')
}

// ---- 14. the basic-mode set -------------------------------------------------
console.log('[basic mode]')
{
  const basic = DEFAULT_HIGHLIGHT_RULES.filter((r) => r.basic === true).map((r) => r.id)
  ok(basic.length === 5, `the basic set stays small (${basic.join(', ') || 'empty'})`)
  for (const id of ['danger', 'secret', 'okstate', 'warnstate', 'badstate']) {
    ok(basic.includes(id), `"${id}" survives basic mode`)
  }
  ok(
    !basic.includes('numbers') && !basic.includes('url') && !basic.includes('path'),
    'the noisy rules are not part of basic mode'
  )
  ok(
    DEFAULT_HIGHLIGHT_RULES.every((r) => r.basic === undefined || r.basic === true),
    'basic is a flag, never explicitly false'
  )
}

// ---- 15. preset categories -------------------------------------------------
console.log('[categories]')
{
  const missing = DEFAULT_HIGHLIGHT_RULES.filter((r) => r.category === undefined).map((r) => r.id)
  ok(missing.length === 0, `every preset carries a category (missing: ${missing.join(', ') || 'none'})`)
  const known = new Set(['safety', 'status', 'file', 'net', 'text', 'metric'])
  ok(
    DEFAULT_HIGHLIGHT_RULES.every((r) => known.has(r.category)),
    'every category is one of the known values'
  )
  const safety = DEFAULT_HIGHLIGHT_RULES.filter((r) => r.category === 'safety').map((r) => r.id)
  ok(safety.length >= 2 && safety.includes('danger') && safety.includes('secret'), 'safety groups danger + secrets')
  const basic = DEFAULT_HIGHLIGHT_RULES.filter((r) => r.basic === true)
  ok(
    basic.every((r) => r.category === 'safety' || r.category === 'status'),
    'basic mode only ever contains safety/status rules'
  )
}

// ---- 16. optional stats sink ----------------------------------------------
console.log('[stats]')
{
  const sink = new Map()
  applyHighlights('SUCCESS 85% ERROR 85%', rules, sink)
  ok(sink.get('okstate')?.hits === 1, `the sink counts hits per rule (okstate=${sink.get('okstate')?.hits})`)
  ok(sink.get('percent')?.hits === 2, 'the same rule counts every one of its matches')
  ok(typeof sink.get('okstate')?.ms === 'number' && sink.get('okstate').ms >= 0, 'the sink records a duration')
  ok(
    applyHighlights('SUCCESS', rules) === applyHighlights('SUCCESS', rules, undefined),
    'passing no sink produces byte-identical output'
  )
  const untouched = new Map()
  applyHighlights('nothing to see here', rules, untouched)
  ok(
    [...untouched.values()].every((stat) => stat.hits === 0),
    'rules that match nothing report zero hits'
  )
}

// ---- 17. theme colour mapping ---------------------------------------------
console.log('[theme colours]')
{
  const theme = {
    colors: {
      red: '#ff0000',
      brightRed: '#ff8888',
      green: '#00ff00',
      brightGreen: '#88ff88',
      yellow: '#ffff00',
      brightYellow: '#ffff88',
      blue: '#0000ff',
      brightBlue: '#8888ff',
      cyan: '#00ffff',
      brightCyan: '#88ffff',
      magenta: '#ff00ff',
      brightMagenta: '#ff88ff'
    }
  }

  ok(paletteMatch('#3fb950')?.name === 'green' && paletteMatch('#3fb950').bright === false, 'the success green buckets to green')
  ok(paletteMatch('#7ee787')?.name === 'green' && paletteMatch('#7ee787').bright === true, 'the light green takes the bright entry')
  ok(paletteMatch('#f85149')?.name === 'red', 'the error red buckets to red')
  ok(paletteMatch('#e3b341')?.name === 'yellow', 'the warning yellow buckets to yellow')
  ok(paletteMatch('#d2a8ff')?.name === 'magenta', 'shell keywords bucket to magenta')
  ok(paletteMatch('#58a6ff')?.name === 'blue', 'links bucket to blue')
  ok(paletteMatch('#8b949e') === null, 'the neutral grey keeps its own colour')

  ok(themeColorFor('#3fb950', theme) === '#00ff00', 'green resolves to the theme green')
  ok(themeColorFor('#7ee787', theme) === '#88ff88', 'light green resolves to the bright green')
  ok(themeColorFor('#8b949e', theme) === '#8b949e', 'a neutral colour is returned untouched')
  ok(themeColorFor('#3fb950', { colors: {} }) === '#3fb950', 'a theme missing that entry falls back to the rule colour')

  const mapped = applyThemeColors(DEFAULT_HIGHLIGHT_RULES, theme)
  const percent = mapped.find((r) => r.id === 'percent')
  ok(
    percent.bands.length === 4 && percent.bands[2].fg === '#88ff88' && percent.bands[3].fg === '#00ff00',
    'value bands are mapped as well (light green vs green stays distinguishable)'
  )
  ok(
    mapped.every((r) => /^#[0-9a-fA-F]{6}$/.test(r.color.fg)),
    'every mapped colour is still a hex colour'
  )
  ok(
    DEFAULT_HIGHLIGHT_RULES.find((r) => r.id === 'okstate').color.fg === '#3fb950',
    'mapping never mutates the preset set itself'
  )
}

// ---- 18. per-host profile selection ---------------------------------------
console.log('[profiles]')
{
  const presets = DEFAULT_HIGHLIGHT_RULES
  const profiles = [
    { id: 'p1', name: 'prod', ruleIds: ['okstate', 'badstate'] },
    { id: 'p2', name: 'empty', ruleIds: [] }
  ]
  ok(rulesForProfile(presets, undefined, profiles).length === presets.length, 'no binding → every rule')
  ok(rulesForProfile(presets, 'missing', profiles).length === presets.length, 'a dangling binding → every rule')
  ok(rulesForProfile(presets, 'p2', profiles).length === presets.length, 'an empty profile → every rule')
  const subset = rulesForProfile(presets, 'p1', profiles)
  ok(
    subset.length === 2 && subset.every((r) => ['okstate', 'badstate'].includes(r.id)),
    'a bound profile narrows the session to its own rules'
  )

  const known = new Set(presets.map((r) => r.id))
  const cleaned = sanitizeProfiles(
    [
      { id: 'a', name: 'ok', ruleIds: ['okstate', 'ghost', 'okstate'] },
      { id: 'a', name: 'dupe', ruleIds: [] },
      { name: 'no id' },
      'nope'
    ],
    known,
    () => undefined
  )
  ok(
    cleaned.length === 1 && cleaned[0].ruleIds.length === 1,
    'profiles are cleaned: ghost rule ids, duplicate ids and junk entries dropped'
  )
  ok(sanitizeProfiles('nope', known, () => undefined).length === 0, 'a non-array profile list is ignored')
  ok(
    excludedByProfile(presets, profiles[0]).length === presets.length - 2,
    'excludedByProfile reports what a profile leaves out'
  )
}

console.log(failed === 0 ? '\n[hl-rules] ALL CHECKS PASSED' : `\n[hl-rules] ${failed} CHECK(S) FAILED`)
process.exit(failed === 0 ? 0 : 1)
