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
  for (const on of [true, false]) {
    const back = await roundTrip({
      terminal: { ...store.loadSettings().terminal, highlightStats: on }
    })
    ok(back.terminal.highlightStats === on, `the stats switch '${on}' survives the round trip`)
  }
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
