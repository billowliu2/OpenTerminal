/**
 * Settings-store self-test (settings-store.mjs).
 *
 * Guards the sanitizer's repair-instead-of-drop behavior:
 *   - closeAction 'ask' survives a save/load round trip (it used to be coerced
 *     to 'tray', which made the "ask every time" option dead in the UI)
 *   - a rule with a repairable shape (priority "5", enabled 1, missing fg
 *     colour) is corrected rather than dropped
 *   - preset rules are carried onto the current pattern set by an upgrade,
 *     without disturbing the user's own edits, deletions or colour choices
 *   - an unusable entry is skipped and written to settings-warnings.log
 *
 * Build + run:
 *   npx esbuild src/main/settingsStore.ts --bundle --platform=node --format=cjs \
 *     --outfile=tests/.settings-store.cjs --alias:electron=./tests/electron-stub.cjs \
 *     --alias:@shared=./src/shared
 *   node tests/settings-store.mjs
 */
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { DEFAULT_HIGHLIGHT_RULES } from '../src/shared/settings.ts'
import { MAX_PATTERN_LEN, runtimeKeyOf } from '../src/shared/ruleValidation.ts'
import { PROBE_VERSION } from '../src/shared/redosProbes.ts'

const require = createRequire(import.meta.url)
const userData = mkdtempSync(join(tmpdir(), 'ot-settings-'))
process.env.OT_STUB_USERDATA = userData

const store = require('./.settings-store.cjs')

let failed = 0
const ok = (cond, msg) => {
  console.log(`  ${cond ? 'ok' : 'FAIL'}: ${msg}`)
  if (!cond) failed++
}

const rule = (over = {}) => ({
  id: 'r1',
  pattern: '\\bERROR\\b',
  enabled: true,
  priority: 5,
  color: { fg: '#ff0000' },
  note: 'note',
  ...over
})

const roundTrip = async (patch) => {
  const current = store.loadSettings()
  await store.saveSettings({ ...current, ...patch })
  return store.loadSettings()
}

// ---- 1. closeAction enum ----------------------------------------------------
console.log('[closeAction]')
for (const action of ['tray', 'exit', 'ask']) {
  const back = (await roundTrip({ system: { ...store.loadSettings().system, closeAction: action } })).system.closeAction
  ok(back === action, `closeAction '${action}' survives the round trip (got '${back}')`)
}
{
  const back = (await roundTrip({ system: { ...store.loadSettings().system, closeAction: 'nonsense' } })).system.closeAction
  ok(back === 'tray', `unknown closeAction falls back to 'tray' (got '${back}')`)
}

// ---- 1b. numeric font settings are clamped on load ---------------------------
// xterm's constructor THROWS on lineHeight < 1 and the throw unmounts the whole
// dockview pane. The value is persisted, so one bad entry bricked every start
// until the file was hand-edited. The sanitizer must repair it instead.
console.log('[font settings clamp]')
{
  const term = store.loadSettings().terminal
  for (const [key, bad, want] of [
    ['lineHeight', 0.85, 1],
    ['lineHeight', 0.95, 1],
    ['lineHeight', 9, 2],
    ['fontSize', 4, 8],
    ['fontSize', 99, 40],
    ['letterSpacing', -3, 0],
    ['letterSpacing', 50, 10]
  ]) {
    const back = (await roundTrip({ terminal: { ...term, [key]: bad } })).terminal[key]
    ok(back === want, `${key} ${bad} is clamped to ${want} on load (got ${back})`)
  }
  // A legal value must survive untouched — the clamp is not a reset.
  const legal = (await roundTrip({ terminal: { ...term, lineHeight: 1.35, fontSize: 18, letterSpacing: 1.5 } })).terminal
  ok(
    legal.lineHeight === 1.35 && legal.fontSize === 18 && legal.letterSpacing === 1.5,
    'legal font values are preserved verbatim'
  )
}

// ---- 2. highlight-rule repair ----------------------------------------------
console.log('[highlight rules]')
{
  const out = (await roundTrip({ highlightRules: [rule()] })).highlightRules
  ok(out.length === 1 && out[0].priority === 5 && out[0].color.fg === '#ff0000', 'well-formed rule is untouched')
}
{
  const out = (await roundTrip({ highlightRules: [rule({ priority: '5' })] })).highlightRules
  ok(out.length === 1 && out[0].priority === 5, `priority "5" repaired to a number (got ${out.length} rule(s))`)
}
{
  const out = (await roundTrip({ highlightRules: [rule({ enabled: 1 })] })).highlightRules
  ok(out.length === 1 && out[0].enabled === true, 'enabled 1 repaired to true')
}
{
  const out = (await roundTrip({ highlightRules: [rule({ color: { bg: '#333333' } })] })).highlightRules
  ok(out.length === 1 && typeof out[0].color.fg === 'string' && out[0].color.bg === '#333333', 'missing fg gets a default colour, bg kept')
}
{
  const out = (await roundTrip({ highlightRules: [rule({ priority: 500 })] })).highlightRules
  ok(out.length === 1 && out[0].priority === 100, 'out-of-range priority is clamped')
}
{
  const out = (await roundTrip({ highlightRules: [rule({ note: 42, extraField: 'kept' })] })).highlightRules
  ok(out.length === 1 && out[0].note === undefined && out[0].extraField === 'kept', 'non-string note dropped, unknown fields preserved')
}
{
  const out = (await roundTrip({ highlightRules: [rule(), rule({ id: undefined })] })).highlightRules
  ok(out.length === 1, 'unusable entry skipped, valid one kept')
}
{
  const out = (await roundTrip({ highlightRules: [] })).highlightRules
  ok(out.length === 0, 'an explicitly empty rule list stays empty')
}
{
  // A non-array highlightRules is a shape error, not "no rules": the built-in
  // rules come back as copies (mutating a loaded list must not poison the
  // module-level preset table) and the fallback is recorded in the warnings log.
  writeFileSync(
    join(userData, 'settings.json'),
    JSON.stringify({ highlightRules: { nope: true } }),
    'utf8'
  )
  const first = store.loadSettings().highlightRules
  ok(first.length > 0, `a non-array highlightRules loads the built-in rules (got ${first.length})`)
  const second = store.loadSettings().highlightRules
  ok(first !== second, 'each load hands out its own array, not the shared preset list')
  first.length = 0
  const afterMutation = store.loadSettings().highlightRules
  ok(afterMutation.length > 0, 'emptying a loaded rule list does not affect the next load')
  const log = existsSync(join(userData, 'settings-warnings.log'))
    ? readFileSync(join(userData, 'settings-warnings.log'), 'utf8')
    : ''
  ok(log.includes('highlightRules: not an array'), 'the fallback is recorded in settings-warnings.log')
}

// ---- 2b. the internal validation proof --------------------------------------
// `validation` is internal metadata written by the rule validator, not user
// input. The store keeps a well-formed record — the compile gate re-checks it
// against the rule's pattern, its flags, the current probe version and the
// running build — and drops a malformed one with a trace, without costing the
// user the rule itself. A proof that is well-formed but no longer applies (an
// older corpus, another environment, an edited pattern) is rewritten to
// `pending` rather than carried forward claiming to be a verdict.
console.log('[rule validation]')
{
  /** The fingerprint the bundled store installed (same inputs, same function). */
  const runtime = runtimeKeyOf({
    app: '0.0.0-stub',
    electron: process.versions.electron ?? '',
    v8: process.versions.v8 ?? ''
  })
  const proof = (over = {}) => ({
    status: 'passed',
    pattern: '\\bERROR\\b',
    flags: 'g',
    probeVersion: PROBE_VERSION,
    runtime,
    ...over
  })

  const kept = (await roundTrip({ highlightRules: [rule({ validation: proof() })] })).highlightRules
  ok(kept.length === 1 && kept[0].validation?.status === 'passed', 'a well-formed proof survives the round trip')
  ok(
    JSON.stringify(Object.keys(kept[0].validation).sort()) ===
      JSON.stringify(['flags', 'pattern', 'probeVersion', 'runtime', 'status']),
    `only the five known fields survive (${Object.keys(kept[0].validation).join(', ')})`
  )

  const shaped = (await roundTrip({ highlightRules: [rule({ validation: proof({ junk: 1 }) })] })).highlightRules
  ok(shaped[0].validation?.junk === undefined, 'extra fields are dropped from the proof')

  for (const [label, bad] of [
    ['a string', 'passed'],
    ['an unknown status', proof({ status: 'trusted' })],
    ['a non-string pattern', proof({ pattern: 7 })],
    ['a non-numeric probe version', proof({ probeVersion: '1' })],
    ['a missing runtime', proof({ runtime: undefined })],
    ['an empty runtime', proof({ runtime: '' })],
    ['a missing status', { pattern: '\\bERROR\\b', flags: 'g', probeVersion: PROBE_VERSION, runtime }]
  ]) {
    const out = (await roundTrip({ highlightRules: [rule({ validation: bad })] })).highlightRules
    ok(out.length === 1, `a ${label} proof does not cost the user the rule`)
    ok(out[0].validation === undefined, `a ${label} proof is dropped`)
  }

  // Stale verdicts: an upgrade (new corpus or new build) must not leave a rule
  // claiming to have passed something it never ran against.
  const olderCorpus = (await roundTrip({
    highlightRules: [rule({ validation: proof({ probeVersion: PROBE_VERSION - 1 }) })]
  })).highlightRules
  ok(olderCorpus[0].validation?.status === 'pending', 'a proof from an older probe set becomes pending')
  ok(olderCorpus[0].validation?.probeVersion === PROBE_VERSION, 'the pending record names the current probe set')

  const otherBuild = (await roundTrip({
    highlightRules: [rule({ validation: proof({ runtime: 'other|other|other' }) })]
  })).highlightRules
  ok(otherBuild[0].validation?.status === 'pending', 'a proof from another build becomes pending')
  ok(otherBuild[0].validation?.runtime === runtime, 'the pending record names the running build')

  const otherFlags = (await roundTrip({
    highlightRules: [rule({ caseInsensitive: true, validation: proof() })]
  })).highlightRules
  ok(otherFlags[0].validation?.status === 'pending', 'a proof for other flags becomes pending')
  ok(otherFlags[0].validation?.flags === 'gi', 'the pending record carries the flags the rule now compiles with')

  // A quarantined verdict that still applies is evidence, not a gap: it stays.
  const quarantined = (await roundTrip({
    highlightRules: [rule({ validation: proof({ status: 'quarantined' }) })]
  })).highlightRules
  ok(quarantined[0].validation?.status === 'quarantined', 'a current quarantine is kept as it stands')

  // Same contract for link rules, which go through the sanitizer instead.
  const linkKept = (await roundTrip({
    linkRules: [{ id: 'l1', pattern: 'BUG-(\\d+)', template: 'https://x/$1', validation: proof({ pattern: 'BUG-(\\d+)' }) }]
  })).linkRules
  ok(linkKept[0].validation?.status === 'passed', 'a well-formed link-rule proof survives the round trip')
  const linkStale = (await roundTrip({
    linkRules: [
      {
        id: 'l1',
        pattern: 'BUG-(\\d+)',
        template: 'https://x/$1',
        validation: proof({ pattern: 'BUG-(\\d+)', runtime: 'other|other|other' })
      }
    ]
  })).linkRules
  ok(linkStale[0].validation?.status === 'pending', 'a link-rule proof from another build becomes pending')

  {
    // The hand-edited case is the one that needs a trace: the record has to be
    // ON DISK when the store reads it (a save sanitizes on the way out and would
    // leave nothing to warn about), so write the file directly.
    writeFileSync(
      join(userData, 'settings.json'),
      JSON.stringify({ highlightRules: [rule({ validation: { status: 'trusted' } })] }),
      'utf8'
    )
    const loaded = store.loadSettings().highlightRules
    ok(
      loaded.length === 1 && loaded[0].validation === undefined,
      'a malformed proof in a hand-edited file is dropped on load'
    )
    const proofLog = existsSync(join(userData, 'settings-warnings.log'))
      ? readFileSync(join(userData, 'settings-warnings.log'), 'utf8')
      : ''
    ok(proofLog.includes('.validation'), 'the drop is recorded in settings-warnings.log')
  }
}

// ---- 2c. the pattern length bound -------------------------------------------
// The engine refuses a pattern over MAX_PATTERN_LEN anyway; refusing it at load
// keeps the paste out of the settings file and leaves a trace.
console.log('[pattern length]')
{
  const over = (await roundTrip({ highlightRules: [rule({ pattern: 'a'.repeat(MAX_PATTERN_LEN + 1) })] })).highlightRules
  ok(over.length === 0, `a pattern over ${MAX_PATTERN_LEN} characters is refused at load`)
  const atLimit = (await roundTrip({ highlightRules: [rule({ pattern: 'a'.repeat(MAX_PATTERN_LEN) })] })).highlightRules
  ok(atLimit.length === 1, `a pattern of exactly ${MAX_PATTERN_LEN} characters is kept`)
}

// ---- 3. value bands ---------------------------------------------------------
console.log('[value bands]')
{
  const out = (
    await roundTrip({
      highlightRules: [
        rule({
          bands: [
            { min: 80, fg: '#00ff00' },
            { min: 0, fg: '#ff0000' }
          ]
        })
      ]
    })
  ).highlightRules
  ok(
    out.length === 1 && out[0].bands?.length === 2 && out[0].bands[0].min === 0,
    'bands survive the round trip, sorted ascending'
  )
}
{
  const out = (
    await roundTrip({
      highlightRules: [
        rule({
          bands: [
            { min: 'x', fg: '#ff0000' },
            { min: 20, fg: 'not-a-colour' },
            { min: 50, fg: '#00ff00' }
          ]
        })
      ]
    })
  ).highlightRules
  ok(
    out.length === 1 && out[0].bands?.length === 1 && out[0].bands[0].min === 50,
    'unusable bands are dropped, the usable one is kept'
  )
}
{
  const out = (await roundTrip({ highlightRules: [rule({ bands: 'nope' })] })).highlightRules
  ok(out.length === 1 && out[0].bands === undefined, 'a non-array bands value is ignored')
}
{
  for (const mode of ['all', 'basic', 'off']) {
    const back = await roundTrip({
      terminal: { ...store.loadSettings().terminal, highlightMode: mode }
    })
    ok(back.terminal.highlightMode === mode, `highlight mode '${mode}' survives the round trip`)
  }
  const bad = await roundTrip({
    terminal: { ...store.loadSettings().terminal, highlightMode: 'nonsense' }
  })
  ok(bad.terminal.highlightMode === 'nonsense', 'an unknown mode is stored as-is (readers normalise it)')
}
{
  const kept = (await roundTrip({ highlightRules: [rule({ basic: true })] })).highlightRules
  ok(kept[0].basic === true, 'a basic rule keeps its flag')
  const dropped = (await roundTrip({ highlightRules: [rule({ basic: 'yes' })] })).highlightRules
  ok(dropped.length === 1 && dropped[0].basic === undefined, 'a non-boolean basic flag is dropped')
}
{
  // lineAnchor: a rule anchored per line must come back still anchored, and a
  // rule that never opted in must stay absent (not `false`) so settings.json
  // stays compact.
  const kept = (await roundTrip({ highlightRules: [rule({ lineAnchor: true })] })).highlightRules
  ok(kept.length === 1 && kept[0].lineAnchor === true, 'a line-anchored rule keeps its flag')
  const absent = (await roundTrip({ highlightRules: [rule()] })).highlightRules
  ok(absent.length === 1 && absent[0].lineAnchor === undefined, 'a rule without the flag keeps it undefined')
  const dropped = (await roundTrip({ highlightRules: [rule({ lineAnchor: 'yes' })] })).highlightRules
  ok(
    dropped.length === 1 && dropped[0].lineAnchor === undefined,
    'a non-boolean lineAnchor flag is dropped'
  )
}
{
  // notify (per-rule "alert on hit"): same shape as lineAnchor — `true` survives,
  // absent stays absent, anything non-boolean is dropped rather than coerced.
  const kept = (await roundTrip({ highlightRules: [rule({ notify: true })] })).highlightRules
  ok(kept.length === 1 && kept[0].notify === true, 'a notify rule keeps its flag')
  const absent = (await roundTrip({ highlightRules: [rule()] })).highlightRules
  ok(absent.length === 1 && absent[0].notify === undefined, 'a rule without the flag keeps it undefined')
  const dropped = (await roundTrip({ highlightRules: [rule({ notify: 'yes' })] })).highlightRules
  ok(
    dropped.length === 1 && dropped[0].notify === undefined,
    'a non-boolean notify flag is dropped'
  )
  // An explicit `false` is indistinct from absent after a save: the sanitizer
  // normalises it away so settings.json never grows a dead key.
  const off = (await roundTrip({ highlightRules: [rule({ notify: false })] })).highlightRules
  ok(off.length === 1 && off[0].notify === undefined, 'notify: false is normalised to undefined')
}
{
  // The preset rule set ships `secret` with the alert on (a leaked key is what
  // the feature exists for) and nothing else flagged. Read from the preset
  // constant rather than from disk: the user's stored set may legitimately have
  // the flag off (see the upgrade note in the report), so this asserts the ship
  // default, not the loaded result.
  const flagged = DEFAULT_HIGHLIGHT_RULES.filter((r) => r.notify === true).map((r) => r.id)
  ok(
    flagged.length === 1 && flagged[0] === 'secret',
    `only the secret preset notifies by default (got ${flagged.join(',')})`
  )
  const secret = DEFAULT_HIGHLIGHT_RULES.find((r) => r.id === 'secret')
  ok(secret?.basic === true && secret?.notify === true, 'the secret preset notifies in both highlight modes')
}
{
  for (const on of [true, false]) {
    const back = await roundTrip({
      terminal: { ...store.loadSettings().terminal, highlightStats: on }
    })
    ok(back.terminal.highlightStats === on, `the stats switch '${on}' survives the round trip`)
  }
}
{
  for (const on of [true, false]) {
    const back = await roundTrip({
      terminal: { ...store.loadSettings().terminal, confirmTabClose: on, confirmSshTabClose: on }
    })
    ok(
      back.terminal.confirmTabClose === on && back.terminal.confirmSshTabClose === on,
      `tab close confirm switches '${on}' survive the round trip`
    )
  }
}
{
  // cjkFontFamily: the CJK fallback slot appended to the font stack. Empty is
  // the default (append nothing, unchanged behaviour); a real family name and
  // a non-string — the settings file is hand-editable, and a number here would
  // otherwise reach `appendCjk` and be concatenated into the stack as text.
  ok(store.loadSettings().terminal.cjkFontFamily === '', 'the CJK fallback defaults to empty')
  for (const cjk of ['Microsoft YaHei', "'Noto Sans CJK SC'", '']) {
    const back = await roundTrip({
      terminal: { ...store.loadSettings().terminal, cjkFontFamily: cjk }
    })
    ok(back.terminal.cjkFontFamily === cjk, `CJK fallback '${cjk}' survives the round trip`)
  }
  const dropped = await roundTrip({
    terminal: { ...store.loadSettings().terminal, cjkFontFamily: 42 }
  })
  ok(
    dropped.terminal.cjkFontFamily === '',
    `a non-string CJK fallback is dropped back to empty (got '${dropped.terminal.cjkFontFamily}')`
  )
}
{
  const rules = [rule({ id: 'keep-1' }), rule({ id: 'keep-2' })]
  await roundTrip({ highlightRules: rules })
  const back = (
    await roundTrip({
      highlightProfiles: [
        { id: 'p1', name: 'production', ruleIds: ['keep-1', 'keep-2'] },
        { id: 'p2', name: 'empty', ruleIds: [] }
      ]
    })
  ).highlightProfiles
  ok(
    back.length === 2 && back[0].name === 'production' && back[0].ruleIds.length === 2,
    'profiles survive the round trip with their rule selections'
  )
  const pruned = (
    await roundTrip({
      highlightProfiles: [{ id: 'p3', name: 'x', ruleIds: ['keep-1', 'gone'] }]
    })
  ).highlightProfiles
  ok(
    pruned.length === 1 && pruned[0].ruleIds.length === 1,
    'a profile drops rule ids that no longer exist'
  )
  const bad = (await roundTrip({ highlightProfiles: [{ name: 'no id' }, 'nope'] })).highlightProfiles
  ok(bad.length === 0, 'malformed profiles are skipped')
}
{
  const kept = (await roundTrip({ highlightRules: [rule({ category: 'status' })] })).highlightRules
  ok(kept[0].category === 'status', 'a known category is kept')
  const dropped = (await roundTrip({ highlightRules: [rule({ category: 'nonsense' })] })).highlightRules
  ok(
    dropped.length === 1 && dropped[0].category === undefined,
    'an unknown category is dropped rather than stored'
  )
}

// ---- 4. preset refresh on an upgrading install ------------------------------
console.log('[preset refresh]')
{
  // The rule set as v1.0.15 shipped it, i.e. what an upgrading user has on disk.
  const V1 = {
    perm: '^[-dlbcps][rwxstST-]{9}',
    path: '(?:^|[\\s:=])(?:/[A-Za-z0-9_.\\-/@+]+|~[A-Za-z0-9_.\\-/]*)',
    shellkw:
      '\\b(if|then|else|elif|fi|for|while|do|done|case|esac|function|return|break|continue|export|source)\\b',
    okstate: '\\b(SUCCESS|PASS|OK|DONE|PASSED)\\b',
    badstate: '\\b(FAILED|ERROR|FAIL|FATAL|WARN|WARNING|DENIED)\\b',
    quoted: '"[^"\\n]*"|\'[^\'\\n]*\'',
    envvar: '\\$\\{?[A-Za-z_][A-Za-z0-9_]*\\}?',
    ipv4: '\\b(?:\\d{1,3}\\.){3}\\d{1,3}(?::\\d{1,5})?\\b',
    datetime: '\\b\\d{4}[-/]\\d{1,2}[-/]\\d{1,2}\\b',
    numbers: '\\b\\d+(?:\\.\\d+)?(?:%)?\\b',
    url: 'https?://[^\\s]+'
  }
  const v1Rule = (id, over = {}) => ({
    id,
    pattern: V1[id],
    enabled: true,
    priority: 10,
    color: { fg: '#123456' },
    builtin: true,
    ...over
  })
  const v1Set = () => Object.keys(V1).map((id) => v1Rule(id))

  const upgraded = (await roundTrip({ highlightRules: v1Set() })).highlightRules
  const okstate = upgraded.find((r) => r.id === 'okstate')
  ok(
    typeof okstate?.pattern === 'string' && okstate.pattern.includes('SUCCEED'),
    'an unedited built-in pattern is refreshed to the current preset'
  )
  ok(okstate?.caseInsensitive === true, 'the refresh brings the case-insensitive flag along')
  ok(
    okstate?.priority === 10 && okstate?.color.fg === '#123456' && okstate?.enabled === true,
    'a refreshed rule keeps the priority, colour and switch the user left it at'
  )
  // The very first url preset (https?:// only, widened by ftp/www alternation
  // later) is a registered legacy pattern too — an early install upgrades
  // exactly like okstate above. This regressed silently before the url entry
  // was added to LEGACY_BUILTIN_PATTERNS.
  const url = upgraded.find((r) => r.id === 'url')
  ok(
    typeof url?.pattern === 'string' && url.pattern.includes('ftp://') && url.pattern !== V1.url,
    'the early url preset (https?:// only) is refreshed to the current one'
  )
  const addedSince = [
    'warnstate',
    'danger',
    'delop',
    'createop',
    'percent',
    'secret',
    'loglevel',
    'rootat',
    'exitcode',
    'http',
    'latency'
  ]
  const stillMissing = addedSince.filter((id) => !upgraded.some((r) => r.id === id))
  ok(
    stillMissing.length === 0,
    `preset rules added since an older install are appended (missing: ${stillMissing.join(', ') || 'none'})`
  )
  ok(
    upgraded.filter((r) => r.builtin !== true).length === 0,
    'no stray rule is invented while refreshing'
  )

  // A rule the user rewrote by hand must survive an upgrade untouched.
  const custom = v1Set().map((r) => (r.id === 'badstate' ? { ...r, pattern: '\\bMY_FAILURE\\b' } : r))
  const afterCustom = (await roundTrip({ highlightRules: custom })).highlightRules
  ok(
    afterCustom.find((r) => r.id === 'badstate')?.pattern === '\\bMY_FAILURE\\b',
    'a hand-edited built-in rule is left alone'
  )

  // The legacy url pattern on a NON-builtin rule must not be refreshed either.
  const nonBuiltin = v1Set().map((r) => (r.id === 'url' ? { ...r, builtin: false } : r))
  const afterNonBuiltin = (await roundTrip({ highlightRules: nonBuiltin })).highlightRules
  ok(
    afterNonBuiltin.find((r) => r.id === 'url')?.pattern === V1.url,
    'the legacy url pattern on a non-builtin rule is left alone'
  )

  // ...and so must a rule the user deleted: it must not come back.
  const pruned = v1Set().filter((r) => r.id !== 'numbers')
  const afterPrune = (await roundTrip({ highlightRules: pruned })).highlightRules
  ok(!afterPrune.some((r) => r.id === 'numbers'), 'a deleted built-in rule is not resurrected')
  ok(
    !afterPrune.some((r) => r.id === 'warnstate'),
    'no untouched preset is added either, so a deletion stays a deletion'
  )

  // Deleting one of the *newly added* presets sticks too (the append guard must
  // not treat the upgraded set as a pristine old one).
  const afterUpgradePrune = (
    await roundTrip({ highlightRules: upgraded.filter((r) => r.id !== 'warnstate') })
  ).highlightRules
  ok(
    !afterUpgradePrune.some((r) => r.id === 'warnstate'),
    'a newly added preset the user deleted is not re-added'
  )

  // Loading the upgraded set again changes nothing further.
  const again = (await roundTrip({ highlightRules: upgraded })).highlightRules
  ok(JSON.stringify(again) === JSON.stringify(upgraded), 'the refresh is idempotent')
}

// ---- 4. warnings land in a log file ----------------------------------------
console.log('[warnings log]')
{
  writeFileSync(
    join(userData, 'settings.json'),
    JSON.stringify({ terminal: { fontSize: '16' }, highlightRules: [rule({ priority: 'x' })] }),
    'utf8'
  )
  store.loadSettings()
  const file = join(userData, 'settings-warnings.log')
  const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
  ok(text.includes('terminal.fontSize'), 'terminal key type mismatch is logged')
  ok(text.includes('priority repaired'), 'rule repair is logged')
  const size = text.length
  store.loadSettings()
  ok(readFileSync(file, 'utf8').length === size, 'identical warnings are not appended twice')
}

// The store wrote settings into a temp userData dir; drop it so repeated runs do
// not litter %TEMP%.
rmSync(userData, { recursive: true, force: true })

console.log(failed === 0 ? '\n[settings] ALL CHECKS PASSED' : `\n[settings] ${failed} CHECK(S) FAILED`)
process.exit(failed === 0 ? 0 : 1)
