/**
 * Settings-store self-test (settings-store.mjs).
 *
 * Guards the sanitizer's repair-instead-of-drop behavior:
 *   - closeAction 'ask' survives a save/load round trip (it used to be coerced
 *     to 'tray', which made the "ask every time" option dead in the UI)
 *   - a rule with a repairable shape (priority "5", enabled 1, missing fg
 *     colour) is corrected rather than dropped
 *   - an unusable entry is skipped and written to settings-warnings.log
 *
 * Build + run:
 *   npx esbuild src/main/settingsStore.ts --bundle --platform=node --format=cjs \
 *     --outfile=tests/.settings-store.cjs --alias:electron=./tests/electron-stub.cjs \
 *     --alias:@shared=./src/shared
 *   node tests/settings-store.mjs
 */
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
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

// ---- 3. warnings land in a log file ----------------------------------------
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

console.log(failed === 0 ? '\n[settings] ALL CHECKS PASSED' : `\n[settings] ${failed} CHECK(S) FAILED`)
process.exit(failed === 0 ? 0 : 1)
